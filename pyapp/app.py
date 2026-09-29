"""
ColabGPU — Flask backend
========================
Single-process Python server that:
  • Serves the static frontend (HTML/CSS/JS) on `/`
  • Exposes REST endpoints under `/api/*` for file management, run control, and chat
  • Streams real-time telemetry (GPU/RAM/SSD/net) over Flask-SocketIO at `/socket.io`
  • Forwards chat completions to the ZAI API (OpenAI-compatible) with SSE streaming

The server binds to port 3000 so the existing Caddy gateway proxies it
transparently without needing any XTransformPort tricks.

Run:  python3 app.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable

import httpx
import psutil
from flask import Flask, request, jsonify, Response, send_from_directory
from flask_socketio import SocketIO

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ZAI SDK configuration — read from the same file the Node SDK uses so we
# don't need a separate secret store.
CONFIG_PATHS = [
    Path.cwd() / ".z-ai-config",
    Path.home() / ".z-ai-config",
    Path("/etc/.z-ai-config"),
]


def load_zai_config() -> dict[str, str]:
    for p in CONFIG_PATHS:
        try:
            cfg = json.loads(p.read_text())
            if cfg.get("baseUrl") and cfg.get("apiKey"):
                return cfg
        except (FileNotFoundError, json.JSONDecodeError):
            continue
    return {}


ZAI_CONFIG = load_zai_config()
ZAI_BASE_URL = ZAI_CONFIG.get("baseUrl", "https://internal-api.z.ai/v1")
ZAI_API_KEY = ZAI_CONFIG.get("apiKey", "")
ZAI_CHAT_ID = ZAI_CONFIG.get("chatId", "")
ZAI_USER_ID = ZAI_CONFIG.get("userId", "")
ZAI_TOKEN = ZAI_CONFIG.get("token", "")

# ---------------------------------------------------------------------------
# In-memory state (single-user sandbox; fine for v0.1)
# ---------------------------------------------------------------------------
@dataclass
class FileRecord:
    id: str
    name: str
    size_bytes: int
    category: str  # llm | dataset | config | other
    uploaded_at: float
    saved_path: str | None = None


@dataclass
class SessionState:
    run_state: str = "idle"  # idle | loading | running | stopped | error
    run_started_at: float | None = None
    active_model: str | None = None
    chat_active: bool = False


session = SessionState()
files_registry: list[FileRecord] = []
files_lock = threading.Lock()


# ---------------------------------------------------------------------------
# File categorization
# ---------------------------------------------------------------------------
LLM_EXTS = {".gguf", ".bin", ".safetensors", ".pt", ".pth", ".onnx", ".ggmf"}
DATASET_EXTS = {".csv", ".json", ".jsonl", ".parquet", ".txt", ".tsv", ".arrow", ".feather"}
CONFIG_EXTS = {".yaml", ".yml", ".toml", ".ini", ".conf"}


def categorize(name: str) -> str:
    ext = Path(name).suffix.lower()
    if ext in LLM_EXTS:
        return "llm"
    if ext in DATASET_EXTS:
        return "dataset"
    if ext in CONFIG_EXTS:
        return "config"
    return "other"


def human_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    units = ["KB", "MB", "GB", "TB"]
    v = n / 1024
    i = 0
    while v >= 1024 and i < len(units) - 1:
        v /= 1024
        i += 1
    return f"{v:.{0 if v >= 100 else 1}f} {units[i]}"


def serialize_file(f: FileRecord) -> dict:
    return {
        "id": f.id,
        "name": f.name,
        "sizeBytes": f.size_bytes,
        "humanSize": human_size(f.size_bytes),
        "category": f.category,
        "uploadedAt": int(f.uploaded_at * 1000),
    }


# ---------------------------------------------------------------------------
# Real telemetry collection
# ---------------------------------------------------------------------------
TOTAL_VRAM_GB = 24.0  # RTX-class card assumption; overridden by nvidia-smi if available

# Smoothed state for simulated GPU (used when no real GPU is present).
_gpu_state = {
    "util": 0.0,
    "mem_used": 0.0,
    "temp_c": 35.0,
    "power_w": 25.0,
    "ssd_read": 0.0,
    "ssd_write": 0.0,
    "net_rx": 0.5,
    "net_tx": 0.5,
}

_prev_disk_io = psutil.disk_io_counters() if hasattr(psutil, "disk_io_counters") else None
_prev_net_io = psutil.net_io_counters() if hasattr(psutil, "net_io_counters") else None
_prev_ts = time.time()


def _drift(prev: float, target: float, step: float, lo: float, hi: float) -> float:
    delta = (target - prev) * 0.18 + ( (hash(str(time.time())) % 1000) / 1000 - 0.5) * step
    return max(lo, min(hi, prev + delta))


def read_nvidia_smi() -> dict | None:
    """Return live GPU stats via nvidia-smi if available, else None."""
    if not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
            timeout=2,
            text=True,
        ).strip().splitlines()[0]
        util, mem_used, mem_total, temp, power = [v.strip() for v in out.split(",")]
        return {
            "util": float(util),
            "mem_used_mib": float(mem_used),
            "mem_total_mib": float(mem_total),
            "temp_c": float(temp),
            "power_w": float(power) if power.lower() != "[n/a]" else 0.0,
        }
    except Exception:
        return None


def collect_metrics() -> dict:
    global _prev_disk_io, _prev_net_io, _prev_ts

    now = time.time()
    dt = max(0.001, now - _prev_ts)

    # RAM
    vm = psutil.virtual_memory()
    ram_total = vm.total / (1024**3)
    ram_used = vm.used / (1024**3)

    # SSD
    du = psutil.disk_usage("/")
    ssd_total = du.total / (1024**3)
    ssd_used = du.used / (1024**3)

    # Disk IO rate (MB/s)
    disk_read_mbps = 0.0
    disk_write_mbps = 0.0
    cur_disk = psutil.disk_io_counters() if hasattr(psutil, "disk_io_counters") else None
    if _prev_disk_io and cur_disk:
        dr = (cur_disk.read_bytes - _prev_disk_io.read_bytes) / (1024**2) / dt
        dw = (cur_disk.write_bytes - _prev_disk_io.write_bytes) / (1024**2) / dt
        disk_read_mbps = max(0.0, dr)
        disk_write_mbps = max(0.0, dw)
    _prev_disk_io = cur_disk

    # Network rate (Mbps)
    net_rx_mbps = 0.0
    net_tx_mbps = 0.0
    cur_net = psutil.net_io_counters() if hasattr(psutil, "net_io_counters") else None
    if _prev_net_io and cur_net:
        rx = (cur_net.bytes_recv - _prev_net_io.bytes_recv) * 8 / 1_000_000 / dt
        tx = (cur_net.bytes_sent - _prev_net_io.bytes_sent) * 8 / 1_000_000 / dt
        net_rx_mbps = max(0.0, rx)
        net_tx_mbps = max(0.0, tx)
    _prev_net_io = cur_net

    _prev_ts = now

    # GPU — prefer real nvidia-smi; otherwise simulate based on run state.
    smi = read_nvidia_smi()
    if smi:
        gpu = {
            "utilization": smi["util"],
            "memoryUsedGb": smi["mem_used_mib"] / 1024,
            "memoryTotalGb": smi["mem_total_mib"] / 1024,
            "tempC": smi["temp_c"],
            "powerW": smi["power_w"],
        }
    else:
        # Simulated GPU telemetry that reacts to run state.
        if session.run_state == "loading":
            util_target = 35.0
            _gpu_state["mem_used"] = min(TOTAL_VRAM_GB * 0.78, _gpu_state["mem_used"] + 0.45)
            temp_target = 50.0
            power_target = 140.0
            ssd_read_target = 850.0
            ssd_write_target = 20.0
            net_rx_target = 5.0
        elif session.run_state == "running":
            util_target = 72.0 + 14 * (hash(str(int(now))) % 1000) / 1000
            if _gpu_state["mem_used"] < TOTAL_VRAM_GB * 0.55:
                _gpu_state["mem_used"] = TOTAL_VRAM_GB * 0.55
            temp_target = 71.0
            power_target = 280.0
            ssd_read_target = 60.0
            ssd_write_target = 35.0
            net_rx_target = 8.0 if session.chat_active else 2.0
        elif session.run_state == "error":
            util_target = 5.0
            temp_target = 40.0
            power_target = 35.0
            ssd_read_target = 0.0
            ssd_write_target = 0.0
            net_rx_target = 0.5
        else:  # idle / stopped
            util_target = 0.0
            _gpu_state["mem_used"] = max(0.0, _gpu_state["mem_used"] - 0.4)
            temp_target = 35.0
            power_target = 25.0
            ssd_read_target = 0.0
            ssd_write_target = 0.0
            net_rx_target = 0.5

        _gpu_state["util"] = _drift(_gpu_state["util"], util_target, 6.0, 0.0, 100.0)
        _gpu_state["temp_c"] = _drift(_gpu_state["temp_c"], temp_target, 1.0, 30.0, 90.0)
        _gpu_state["power_w"] = _drift(_gpu_state["power_w"], power_target, 18.0, 15.0, 450.0)
        # Use REAL disk/network rates when system is idle so the user sees
        # actual disk activity, but boost toward simulated values when busy.
        _gpu_state["ssd_read"] = _drift(_gpu_state["ssd_read"], max(disk_read_mbps, ssd_read_target), 80, 0, 2000)
        _gpu_state["ssd_write"] = _drift(_gpu_state["ssd_write"], max(disk_write_mbps, ssd_write_target), 30, 0, 800)
        _gpu_state["net_rx"] = _drift(_gpu_state["net_rx"], max(net_rx_mbps, net_rx_target), 1.5, 0, 50)
        _gpu_state["net_tx"] = _drift(_gpu_state["net_tx"], net_tx_mbps, 1.2, 0, 50)

        gpu = {
            "utilization": _gpu_state["util"],
            "memoryUsedGb": _gpu_state["mem_used"],
            "memoryTotalGb": TOTAL_VRAM_GB,
            "tempC": _gpu_state["temp_c"],
            "powerW": _gpu_state["power_w"],
        }
        # Use the smoothed rates for display when simulated.
        if not smi:
            disk_read_mbps = _gpu_state["ssd_read"]
            disk_write_mbps = _gpu_state["ssd_write"]
            net_rx_mbps = _gpu_state["net_rx"]
            net_tx_mbps = _gpu_state["net_tx"]

    return {
        "ts": int(now * 1000),
        "gpu": gpu,
        "ram": {"usedGb": round(ram_used, 2), "totalGb": round(ram_total, 2)},
        "ssd": {
            "usedGb": round(ssd_used, 2),
            "totalGb": round(ssd_total, 2),
            "readMbps": round(disk_read_mbps, 1),
            "writeMbps": round(disk_write_mbps, 1),
        },
        "net": {"rxMbps": round(net_rx_mbps, 2), "txMbps": round(net_tx_mbps, 2)},
        "gpu_real": bool(smi),
    }


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["SECRET_KEY"] = "colab-gpu-dev-secret"
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",
    ping_timeout=60,
    ping_interval=25,
)


# ----- Static routes ------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# ----- REST API: files ----------------------------------------------------
@app.route("/api/files", methods=["GET"])
def list_files():
    with files_lock:
        files = [serialize_file(f) for f in files_registry]
    total = sum(f.size_bytes for f in files_registry)
    return jsonify({"files": files, "totalFiles": len(files), "totalSizeBytes": total})


@app.route("/api/files", methods=["POST"])
def upload_files():
    saved = []
    for key in request.files:
        for f in request.files.getlist(key):
            if not f or not f.filename:
                continue
            fid = str(uuid.uuid4())
            category = categorize(f.filename)
            # Save to disk regardless of size — Python can handle it.
            safe_name = Path(f.filename).name
            dest = UPLOAD_DIR / f"{fid}-{safe_name}"
            f.save(dest)
            size = dest.stat().st_size
            with files_lock:
                rec = FileRecord(
                    id=fid,
                    name=safe_name,
                    size_bytes=size,
                    category=category,
                    uploaded_at=time.time(),
                    saved_path=str(dest),
                )
                files_registry.append(rec)
            saved.append(serialize_file(rec))
    with files_lock:
        files = [serialize_file(f) for f in files_registry]
    total = sum(f.size_bytes for f in files_registry)
    return jsonify({"created": saved, "files": files, "totalFiles": len(files), "totalSizeBytes": total})


@app.route("/api/files", methods=["DELETE"])
def delete_file():
    fid = request.args.get("id")
    if not fid:
        return jsonify({"error": "id required"}), 400
    with files_lock:
        for i, f in enumerate(files_registry):
            if f.id == fid:
                if f.saved_path and os.path.exists(f.saved_path):
                    try:
                        os.remove(f.saved_path)
                    except OSError:
                        pass
                files_registry.pop(i)
                return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404


# ----- REST API: run control ---------------------------------------------
@app.route("/api/run", methods=["POST"])
def run_control():
    body = request.get_json(silent=True) or {}
    action = body.get("action", "start")
    model = body.get("model")
    if action == "start":
        session.run_state = "loading"
        session.run_started_at = time.time()
        if model:
            session.active_model = model
        socketio.emit("session:state", _session_dict())
        # Auto-transition loading → running after 4.5s
        def _promote():
            time.sleep(4.5)
            if session.run_state == "loading":
                session.run_state = "running"
                socketio.emit("session:state", _session_dict())
        threading.Thread(target=_promote, daemon=True).start()
    else:
        session.run_state = "stopped"
        session.run_started_at = None
        socketio.emit("session:state", _session_dict())
        def _idle():
            time.sleep(2.0)
            if session.run_state == "stopped":
                session.run_state = "idle"
                socketio.emit("session:state", _session_dict())
        threading.Thread(target=_idle, daemon=True).start()
    return jsonify({"ok": True, "action": action, "model": session.active_model})


def _session_dict() -> dict:
    return {
        "runState": session.run_state,
        "activeModel": session.active_model,
        "runStartedAt": int(session.run_started_at * 1000) if session.run_started_at else None,
    }


# ----- REST API: chat (SSE streaming) ------------------------------------
SYSTEM_PROMPT = (
    "You are a helpful AI assistant loaded from the user's uploaded model file. "
    "Answer clearly and concisely. Demonstrate capability across reasoning, code, "
    "and instruction-following."
)


@app.route("/api/chat", methods=["POST"])
def chat():
    body = request.get_json(silent=True) or {}
    messages: list[dict] = body.get("messages") or []
    if not messages:
        return jsonify({"error": "messages required"}), 400

    # Always prepend the system prompt if the caller didn't already.
    if not messages or messages[0].get("role") != "system":
        messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages

    def generate() -> Iterable[bytes]:
        started_at = time.time()
        # Mark chat as active so the simulated GPU bumps up net traffic.
        session.chat_active = True
        try:
            url = f"{ZAI_BASE_URL}/chat/completions"
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {ZAI_API_KEY}",
                "X-Z-AI-From": "Z",
            }
            if ZAI_CHAT_ID:
                headers["X-Chat-Id"] = ZAI_CHAT_ID
            if ZAI_USER_ID:
                headers["X-User-Id"] = ZAI_USER_ID
            if ZAI_TOKEN:
                headers["X-Token"] = ZAI_TOKEN
            payload = {
                "messages": messages,
                "stream": True,
                "thinking": {"type": "disabled"},
            }
            token_count = 0
            with httpx.Client(timeout=60.0) as client:
                with client.stream("POST", url, headers=headers, json=payload) as resp:
                    if resp.status_code != 200:
                        body = resp.read().decode("utf-8", errors="replace")
                        yield (json.dumps({"type": "error", "message": f"HTTP {resp.status_code}: {body[:200]}"}) + "\n").encode()
                        return
                    buf = ""
                    for chunk in resp.iter_text():
                        if not chunk:
                            continue
                        buf += chunk
                        lines = buf.split("\n")
                        buf = lines.pop() or ""
                        for line in lines:
                            line = line.strip()
                            if not line or not line.startswith("data:"):
                                continue
                            data = line[5:].strip()
                            if data == "[DONE]":
                                continue
                            try:
                                evt = json.loads(data)
                                token = evt.get("choices", [{}])[0].get("delta", {}).get("content")
                                if token:
                                    yield (json.dumps({"type": "token", "content": token}) + "\n").encode()
                                    token_count += 1
                            except json.JSONDecodeError:
                                continue
            yield (json.dumps({
                "type": "done",
                "latencyMs": int((time.time() - started_at) * 1000),
                "tokens": token_count,
                "ts": int(time.time() * 1000),
            }) + "\n").encode()
        except Exception as e:
            yield (json.dumps({"type": "error", "message": str(e)}) + "\n").encode()
        finally:
            session.chat_active = False

    return Response(generate(), mimetype="application/x-ndjson")


# ----- REST API: live system snapshot (for the dashboard fallback) -------
@app.route("/api/metrics", methods=["GET"])
def metrics_snapshot():
    return jsonify(collect_metrics())


# ----- WebSocket events ---------------------------------------------------
@socketio.on("connect")
def on_connect():
    socketio.emit("session:state", _session_dict(), to=request.sid)


@socketio.on("run:start")
def on_run_start(data=None):
    model = (data or {}).get("model") if isinstance(data, dict) else None
    session.run_state = "loading"
    session.run_started_at = time.time()
    if model:
        session.active_model = model
    socketio.emit("session:state", _session_dict())

    def _promote():
        time.sleep(4.5)
        if session.run_state == "loading":
            session.run_state = "running"
            socketio.emit("session:state", _session_dict())
    threading.Thread(target=_promote, daemon=True).start()


@socketio.on("run:stop")
def on_run_stop(_data=None):
    session.run_state = "stopped"
    session.run_started_at = None
    socketio.emit("session:state", _session_dict())

    def _idle():
        time.sleep(2.0)
        if session.run_state == "stopped":
            session.run_state = "idle"
            socketio.emit("session:state", _session_dict())
    threading.Thread(target=_idle, daemon=True).start()


@socketio.on("chat:active")
def on_chat_active(data):
    session.chat_active = bool(data)


# ----- Background metrics broadcaster ------------------------------------
def metrics_broadcaster():
    while True:
        try:
            metrics = collect_metrics()
            socketio.emit("metrics", metrics)
        except Exception as e:
            print(f"[metrics] error: {e}")
        socketio.sleep(1.0)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("=" * 60)
    print("  ColabGPU — Flask backend")
    print(f"  ZAI base URL: {ZAI_BASE_URL}")
    print(f"  ZAI API key: {'set' if ZAI_API_KEY else 'MISSING'}")
    print(f"  Upload dir:  {UPLOAD_DIR}")
    print(f"  nvidia-smi:  {'available' if shutil.which('nvidia-smi') else 'not found — using simulated GPU'}")
    print("  Listening on http://0.0.0.0:3000")
    print("=" * 60)
    threading.Thread(target=metrics_broadcaster, daemon=True).start()
    # Use threaded mode so SSE responses don't block the WebSocket broadcast.
    socketio.run(app, host="0.0.0.0", port=3000, debug=False, allow_unsafe_werkzeug=True)
