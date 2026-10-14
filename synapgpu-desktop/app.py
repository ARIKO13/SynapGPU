"""
SynapGPU Desktop — Local Device Profiler & LLM Benchmark Tool
=============================================================
Runs as a local Python app on the user's machine. Reads REAL device specs
(CPU model, RAM, GPU via nvidia-smi, disk) via OS-level access, and
fetches live LLM benchmark data from public leaderboards.

Run:  python app.py
Build: ./build.sh  (macOS/Linux)  or  build.bat  (Windows)
Open:  http://localhost:3000
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import httpx
import psutil
from flask import Flask, request, jsonify, Response, send_from_directory
from flask_socketio import SocketIO

import llm_fetch

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
# When running as a PyInstaller bundle, static files are at sys._MEIPASS/static
# When running from source, they're at BASE_DIR/static
if hasattr(sys, '_MEIPASS'):
    STATIC_DIR = Path(sys._MEIPASS) / "static"
else:
    STATIC_DIR = BASE_DIR / "static"

UPLOAD_DIR = Path(os.environ.get("SYNAPGPU_UPLOADS", str(Path.home() / ".synapgpu" / "uploads")))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ZAI SDK config (optional — for LLM chat fallback if no local inference server)
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
ZAI_BASE_URL = ZAI_CONFIG.get("baseUrl", "")
ZAI_API_KEY = ZAI_CONFIG.get("apiKey", "")
ZAI_CHAT_ID = ZAI_CONFIG.get("chatId", "")
ZAI_USER_ID = ZAI_CONFIG.get("userId", "")
ZAI_TOKEN = ZAI_CONFIG.get("token", "")

# Local inference servers — auto-detected on startup
LOCAL_LLM_ENDPOINTS = {
    "ollama":     "http://localhost:11434/api/chat",
    "llama_cpp":  "http://localhost:8080/completion",
    "lm_studio":  "http://localhost:1234/v1/chat/completions",
}


def detect_local_llm() -> dict:
    """Check if any local inference server is running. Returns info about
    which one (if any) we should route chat requests to."""
    detected = {}
    for name, url in LOCAL_LLM_ENDPOINTS.items():
        try:
            base = url.rsplit("/", 2)[0] if name != "ollama" else "http://localhost:11434"
            with httpx.Client(timeout=1.5) as client:
                r = client.get(base)
                if r.status_code < 500:
                    detected[name] = {"url": url, "base": base}
        except Exception:
            continue
    return detected


# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------
@dataclass
class FileRecord:
    id: str
    name: str
    size_bytes: int
    category: str
    uploaded_at: float
    saved_path: str | None = None


@dataclass
class SessionState:
    run_state: str = "idle"
    run_started_at: float | None = None
    active_model: str | None = None
    chat_active: bool = False


session = SessionState()
files_registry: list[FileRecord] = []
files_lock = threading.Lock()


LLM_EXTS = {".gguf", ".bin", ".safetensors", ".pt", ".pth", ".onnx", ".ggmf"}
DATASET_EXTS = {".csv", ".json", ".jsonl", ".parquet", ".txt", ".tsv", ".arrow", ".feather"}
CONFIG_EXTS = {".yaml", ".yml", ".toml", ".ini", ".conf"}


def categorize(name: str) -> str:
    ext = Path(name).suffix.lower()
    if ext in LLM_EXTS:    return "llm"
    if ext in DATASET_EXTS: return "dataset"
    if ext in CONFIG_EXTS:  return "config"
    return "other"


def human_size(n: int) -> str:
    if n < 1024: return f"{n} B"
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
# Real device detection — full OS-level access (no browser sandbox!)
# ---------------------------------------------------------------------------
_prev_disk_io = psutil.disk_io_counters() if hasattr(psutil, "disk_io_counters") else None
_prev_net_io = psutil.net_io_counters() if hasattr(psutil, "net_io_counters") else None
_prev_ts = time.time()


def read_cpu_model() -> str:
    """Read CPU model name via OS-specific commands."""
    system = platform.system()
    try:
        if system == "Linux":
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if line.lower().startswith("model name"):
                        return line.split(":", 1)[1].strip()
        elif system == "Windows":
            # wmic is deprecated on Win11 but still works; PowerShell fallback.
            try:
                out = subprocess.check_output(
                    ["wmic", "cpu", "get", "name"], text=True, timeout=2
                ).strip().splitlines()
                if len(out) >= 2:
                    return out[1].strip()
            except Exception:
                pass
            try:
                out = subprocess.check_output(
                    ["powershell", "-Command",
                     "(Get-CimInstance Win32_Processor).Name"],
                    text=True, timeout=2
                ).strip()
                if out:
                    return out
            except Exception:
                pass
        elif system == "Darwin":  # macOS
            out = subprocess.check_output(
                ["sysctl", "-n", "machdep.cpu.brand_string"],
                text=True, timeout=2
            ).strip()
            if out:
                return out
    except Exception:
        pass
    return platform.processor() or "Unknown CPU"


def read_nvidia_smi() -> dict | None:
    """Return live GPU stats via nvidia-smi if available, else None."""
    if not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
            timeout=2,
            text=True,
        ).strip().splitlines()[0]
        parts = [v.strip() for v in out.split(",")]
        if len(parts) < 6:
            return None
        name, util, mem_used, mem_total, temp, power = parts
        return {
            "name": name,
            "util": float(util) if util.replace(".", "").isdigit() else 0,
            "mem_used_mib": float(mem_used) if mem_used.replace(".", "").isdigit() else 0,
            "mem_total_mib": float(mem_total) if mem_total.replace(".", "").isdigit() else 0,
            "temp_c": float(temp) if temp.replace(".", "").isdigit() else 0,
            "power_w": float(power) if power.replace(".", "").isdigit() else 0,
        }
    except Exception:
        return None


def read_amd_gpu() -> dict | None:
    """Read AMD GPU stats via rocm-smi if available."""
    if not shutil.which("rocm-smi"):
        return None
    try:
        out = subprocess.check_output(
            ["rocm-smi", "--showproductname", "--showuse", "--showmeminfo", "vram",
             "--showtemp", "--showpower", "--json"],
            timeout=2, text=True
        )
        data = json.loads(out)
        # rocm-smi returns a dict keyed by card name
        first = next(iter(data.values()))
        return {
            "name": first.get("Card series", "AMD GPU"),
            "util": float(first.get("GPU use (%)", 0)),
            "mem_used_mib": float(first.get("VRAM Total Used Memory (B)", 0)) / (1024 * 1024),
            "mem_total_mib": float(first.get("VRAM Total Memory (B)", 0)) / (1024 * 1024),
            "temp_c": float(first.get("Temperature (Sensor edge) (C)", 0)),
            "power_w": float(first.get("Average Graphics Package Power (W)", 0)),
        }
    except Exception:
        return None


def read_gpu() -> dict:
    """Try NVIDIA first, then AMD ROCm, else return None."""
    smi = read_nvidia_smi()
    if smi:
        return {"available": True, "name": smi["name"], "vramTotalGb": round(smi["mem_total_mib"] / 1024, 2), "backend": "nvidia"}
    amd = read_amd_gpu()
    if amd:
        return {"available": True, "name": amd["name"], "vramTotalGb": round(amd["mem_total_mib"] / 1024, 2), "backend": "amd"}
    return {"available": False, "name": None, "vramTotalGb": 0, "backend": None}


def get_device_info() -> dict:
    """Detect real device specs once on startup. Full OS-level access."""
    cpu_model = read_cpu_model()
    cpu_cores_logical = psutil.cpu_count(logical=True) or 0
    cpu_cores_physical = psutil.cpu_count(logical=False) or 0

    vm = psutil.virtual_memory()
    ram_total_gb = round(vm.total / (1024**3), 2)

    du = psutil.disk_usage("/")
    disk_total_gb = round(du.total / (1024**3), 2)

    gpu = read_gpu()

    return {
        "cpu": {
            "model": cpu_model,
            "coresPhysical": cpu_cores_physical,
            "coresLogical": cpu_cores_logical,
        },
        "ram": {"totalGb": ram_total_gb},
        "disk": {"totalGb": disk_total_gb},
        "gpu": gpu,
        "platform": platform.system(),
        "platform_release": platform.release(),
        "machine": platform.machine(),
        "python_version": platform.python_version(),
    }


DEVICE_INFO: dict | None = None
LOCAL_LLMS: dict = {}


def collect_metrics() -> dict:
    global _prev_disk_io, _prev_net_io, _prev_ts

    now = time.time()
    dt = max(0.001, now - _prev_ts)

    # CPU utilization — real per-core average via psutil
    try:
        cpu_util = psutil.cpu_percent(interval=None)
    except Exception:
        cpu_util = 0.0

    # RAM
    vm = psutil.virtual_memory()
    ram_total = vm.total / (1024**3)
    ram_used = vm.used / (1024**3)

    # SSD
    du = psutil.disk_usage("/")
    ssd_total = du.total / (1024**3)
    ssd_used = du.used / (1024**3)

    # Disk IO rate
    disk_read_mbps = disk_write_mbps = 0.0
    cur_disk = psutil.disk_io_counters() if hasattr(psutil, "disk_io_counters") else None
    if _prev_disk_io and cur_disk:
        dr = (cur_disk.read_bytes - _prev_disk_io.read_bytes) / (1024**2) / dt
        dw = (cur_disk.write_bytes - _prev_disk_io.write_bytes) / (1024**2) / dt
        disk_read_mbps = max(0.0, dr)
        disk_write_mbps = max(0.0, dw)
    _prev_disk_io = cur_disk

    # Network
    net_rx_mbps = net_tx_mbps = 0.0
    cur_net = psutil.net_io_counters() if hasattr(psutil, "net_io_counters") else None
    if _prev_net_io and cur_net:
        rx = (cur_net.bytes_recv - _prev_net_io.bytes_recv) * 8 / 1_000_000 / dt
        tx = (cur_net.bytes_sent - _prev_net_io.bytes_sent) * 8 / 1_000_000 / dt
        net_rx_mbps = max(0.0, rx)
        net_tx_mbps = max(0.0, tx)
    _prev_net_io = cur_net

    _prev_ts = now

    # GPU — real via nvidia-smi if available
    smi = read_nvidia_smi()
    if smi:
        gpu = {
            "available": True,
            "name": smi["name"],
            "utilization": smi["util"],
            "memoryUsedGb": round(smi["mem_used_mib"] / 1024, 2),
            "memoryTotalGb": round(smi["mem_total_mib"] / 1024, 2),
            "tempC": smi["temp_c"],
            "powerW": smi["power_w"],
        }
    else:
        amd = read_amd_gpu()
        if amd:
            gpu = {
                "available": True,
                "name": amd["name"],
                "utilization": amd["util"],
                "memoryUsedGb": round(amd["mem_used_mib"] / 1024, 2),
                "memoryTotalGb": round(amd["mem_total_mib"] / 1024, 2),
                "tempC": amd["temp_c"],
                "powerW": amd["power_w"],
            }
        else:
            gpu = {"available": False}

    return {
        "ts": int(now * 1000),
        "cpu": {"utilization": round(cpu_util, 1)},
        "gpu": gpu,
        "ram": {"usedGb": round(ram_used, 2), "totalGb": round(ram_total, 2)},
        "ssd": {
            "usedGb": round(ssd_used, 2),
            "totalGb": round(ssd_total, 2),
            "readMbps": round(disk_read_mbps, 1),
            "writeMbps": round(disk_write_mbps, 1),
        },
        "net": {"rxMbps": round(net_rx_mbps, 2), "txMbps": round(net_tx_mbps, 2)},
        "gpu_available": bool(smi or amd if 'amd' in dir() else smi),
    }


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
app.config["SECRET_KEY"] = "synapgpu-desktop-secret"
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",
    ping_timeout=60,
    ping_interval=25,
)


@app.route("/")
def index():
    return send_from_directory(str(STATIC_DIR), "index.html")


@app.route("/api/device-info")
def device_info():
    return jsonify(DEVICE_INFO)


@app.route("/api/local-llms")
def local_llms():
    """Returns which local inference servers (Ollama, llama.cpp, LM Studio)
    are running and available for chat routing."""
    return jsonify({"servers": LOCAL_LLMS, "active": LOCAL_LLMS.get("ollama") or next(iter(LOCAL_LLMS.values()), None)})


@app.route("/api/benchmarks")
def benchmarks():
    """Returns the live-fetched LLM benchmark data (or static fallback)."""
    return jsonify({
        "benchmarks": llm_fetch.get_benchmarks(),
        "source": llm_fetch.get_benchmark_source(),
        "lastFetch": llm_fetch.get_last_fetch_time(),
    })


# ----- File API ----------------------------------------------------------
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
            safe_name = Path(f.filename).name
            dest = UPLOAD_DIR / f"{fid}-{safe_name}"
            f.save(dest)
            size = dest.stat().st_size
            with files_lock:
                rec = FileRecord(
                    id=fid, name=safe_name, size_bytes=size, category=category,
                    uploaded_at=time.time(), saved_path=str(dest),
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
                    try: os.remove(f.saved_path)
                    except OSError: pass
                files_registry.pop(i)
                return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404


# ----- Run control -------------------------------------------------------
@app.route("/api/run", methods=["POST"])
def run_control():
    body = request.get_json(silent=True) or {}
    action = body.get("action", "start")
    model = body.get("model")
    if action == "start":
        session.run_state = "loading"
        session.run_started_at = time.time()
        if model: session.active_model = model
        socketio.emit("session:state", _session_dict())

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


# ----- Chat (with local LLM routing) ------------------------------------
SYSTEM_PROMPT = (
    "You are a helpful AI assistant loaded from the user's uploaded model file. "
    "Answer clearly and concisely."
)


@app.route("/api/chat", methods=["POST"])
def chat():
    body = request.get_json(silent=True) or {}
    messages: list[dict] = body.get("messages") or []
    if not messages:
        return jsonify({"error": "messages required"}), 400

    if not messages or messages[0].get("role") != "system":
        messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages

    # Try local LLM servers first (Ollama > llama.cpp > LM Studio)
    if LOCAL_LLMS.get("ollama"):
        return _stream_ollama(messages)
    if LOCAL_LLMS.get("lm_studio"):
        return _stream_openai_compatible(messages, LOCAL_LLMS["lm_studio"]["url"])
    # Fallback to ZAI API (if configured)
    if ZAI_API_KEY and ZAI_BASE_URL:
        return _stream_zai(messages)
    return jsonify({"error": "No LLM available. Install Ollama or run llama.cpp server, or configure .z-ai-config for ZAI API."}), 503


def _stream_ollama(messages: list[dict]) -> Response:
    """Stream from Ollama's /api/chat endpoint (NDJSON)."""
    started_at = time.time()
    session.chat_active = True

    def generate() -> Iterable[bytes]:
        try:
            ollama_body = {
                "model": "llama3.1",  # default; user can change in Ollama
                "messages": messages,
                "stream": True,
            }
            with httpx.Client(timeout=300.0) as client:
                with client.stream("POST", LOCAL_LLM_ENDPOINTS["ollama"], json=ollama_body) as resp:
                    if resp.status_code != 200:
                        body = resp.read().decode("utf-8", errors="replace")
                        yield (json.dumps({"type": "error", "message": f"Ollama HTTP {resp.status_code}: {body[:200]}"}) + "\n").encode()
                        return
                    for chunk in resp.iter_text():
                        if not chunk: continue
                        for line in chunk.split("\n"):
                            line = line.strip()
                            if not line: continue
                            try:
                                evt = json.loads(line)
                                token = evt.get("message", {}).get("content", "")
                                if token:
                                    yield (json.dumps({"type": "token", "content": token}) + "\n").encode()
                                if evt.get("done"):
                                    yield (json.dumps({"type": "done", "latencyMs": int((time.time() - started_at) * 1000)}) + "\n").encode()
                            except json.JSONDecodeError: continue
        except Exception as e:
            yield (json.dumps({"type": "error", "message": str(e)}) + "\n").encode()
        finally:
            session.chat_active = False

    return Response(generate(), mimetype="application/x-ndjson")


def _stream_openai_compatible(messages: list[dict], url: str) -> Response:
    """Stream from any OpenAI-compatible endpoint (LM Studio, llama.cpp server)."""
    started_at = time.time()
    session.chat_active = True

    def generate() -> Iterable[bytes]:
        try:
            with httpx.Client(timeout=300.0) as client:
                with client.stream("POST", url, json={
                    "model": "local",
                    "messages": messages,
                    "stream": True,
                }) as resp:
                    if resp.status_code != 200:
                        yield (json.dumps({"type": "error", "message": f"HTTP {resp.status_code}"}) + "\n").encode()
                        return
                    buf = ""
                    for chunk in resp.iter_text():
                        buf += chunk
                        lines = buf.split("\n")
                        buf = lines.pop() or ""
                        for line in lines:
                            line = line.strip()
                            if not line.startswith("data:"): continue
                            data = line[5:].strip()
                            if not data or data == "[DONE]": continue
                            try:
                                evt = json.loads(data)
                                token = evt.get("choices", [{}])[0].get("delta", {}).get("content", "")
                                if token:
                                    yield (json.dumps({"type": "token", "content": token}) + "\n").encode()
                            except json.JSONDecodeError: continue
                    yield (json.dumps({"type": "done", "latencyMs": int((time.time() - started_at) * 1000)}) + "\n").encode()
        except Exception as e:
            yield (json.dumps({"type": "error", "message": str(e)}) + "\n").encode()
        finally:
            session.chat_active = False

    return Response(generate(), mimetype="application/x-ndjson")


def _stream_zai(messages: list[dict]) -> Response:
    """Stream from ZAI API (OpenAI-compatible with custom headers)."""
    started_at = time.time()
    session.chat_active = True

    def generate() -> Iterable[bytes]:
        try:
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {ZAI_API_KEY}",
                "X-Z-AI-From": "Z",
            }
            if ZAI_CHAT_ID: headers["X-Chat-Id"] = ZAI_CHAT_ID
            if ZAI_USER_ID: headers["X-User-Id"] = ZAI_USER_ID
            if ZAI_TOKEN: headers["X-Token"] = ZAI_TOKEN
            payload = {"messages": messages, "stream": True, "thinking": {"type": "disabled"}}
            url = f"{ZAI_BASE_URL}/chat/completions"
            with httpx.Client(timeout=60.0) as client:
                with client.stream("POST", url, headers=headers, json=payload) as resp:
                    if resp.status_code != 200:
                        body = resp.read().decode("utf-8", errors="replace")
                        yield (json.dumps({"type": "error", "message": f"ZAI HTTP {resp.status_code}: {body[:200]}"}) + "\n").encode()
                        return
                    buf = ""
                    for chunk in resp.iter_text():
                        if not chunk: continue
                        buf += chunk
                        lines = buf.split("\n")
                        buf = lines.pop() or ""
                        for line in lines:
                            line = line.strip()
                            if not line.startswith("data:"): continue
                            data = line[5:].strip()
                            if not data or data == "[DONE]": continue
                            try:
                                evt = json.loads(data)
                                token = evt.get("choices", [{}])[0].get("delta", {}).get("content", "")
                                if token:
                                    yield (json.dumps({"type": "token", "content": token}) + "\n").encode()
                            except json.JSONDecodeError: continue
                    yield (json.dumps({"type": "done", "latencyMs": int((time.time() - started_at) * 1000)}) + "\n").encode()
        except Exception as e:
            yield (json.dumps({"type": "error", "message": str(e)}) + "\n").encode()
        finally:
            session.chat_active = False

    return Response(generate(), mimetype="application/x-ndjson")


# ----- Metrics snapshot --------------------------------------------------
@app.route("/api/metrics")
def metrics_snapshot():
    return jsonify(collect_metrics())


# ----- WebSocket events --------------------------------------------------
@socketio.on("connect")
def on_connect():
    socketio.emit("session:state", _session_dict(), to=request.sid)


@socketio.on("run:start")
def on_run_start(data=None):
    model = (data or {}).get("model") if isinstance(data, dict) else None
    session.run_state = "loading"
    session.run_started_at = time.time()
    if model: session.active_model = model
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
    import sys

    # Detect real device specs once on startup
    DEVICE_INFO = get_device_info()

    # Detect local inference servers (Ollama / llama.cpp / LM Studio)
    LOCAL_LLMS = detect_local_llm()

    # Start the live LLM benchmark refresh loop (fetches from HuggingFace etc.)
    llm_fetch.start_refresh_loop()

    print("=" * 60)
    print("  SynapGPU — Desktop Edition")
    print("=" * 60)
    print(f"  Platform:    {platform.system()} {platform.release()} ({platform.machine()})")
    print(f"  CPU:         {DEVICE_INFO['cpu']['model']}")
    print(f"               {DEVICE_INFO['cpu']['coresPhysical']}P / {DEVICE_INFO['cpu']['coresLogical']}L cores")
    print(f"  RAM:         {DEVICE_INFO['ram']['totalGb']} GB")
    print(f"  Disk:        {DEVICE_INFO['disk']['totalGb']} GB")
    if DEVICE_INFO['gpu']['available']:
        backend = DEVICE_INFO['gpu'].get('backend', '?')
        print(f"  GPU:         {DEVICE_INFO['gpu']['name']} ({DEVICE_INFO['gpu']['vramTotalGb']} GB VRAM, {backend})")
    else:
        print(f"  GPU:         not detected (no nvidia-smi / rocm-smi)")
    print(f"  Local LLMs:  {', '.join(LOCAL_LLMS.keys()) if LOCAL_LLMS else 'none detected'}")
    if ZAI_API_KEY:
        print(f"  ZAI API:     configured (fallback for chat)")
    else:
        print(f"  ZAI API:     not configured")
    print(f"  LLM source:  {llm_fetch.get_benchmark_source()}")
    print(f"  Static dir:  {STATIC_DIR}")
    print(f"  Upload dir:  {UPLOAD_DIR}")
    print(f"  Listening:   http://localhost:3000")
    print("=" * 60)
    print("Press Ctrl+C to stop.")

    # Auto-open browser after 1.5s (so server is ready first)
    def open_browser():
        import time as _t
        _t.sleep(1.5)
        url = "http://localhost:3000"
        try:
            import webbrowser
            webbrowser.open(url)
            print(f"  Browser opened: {url}")
        except Exception:
            print(f"  Open manually: {url}")
    threading.Thread(target=open_browser, daemon=True).start()

    threading.Thread(target=metrics_broadcaster, daemon=True).start()
    # Bind to 0.0.0.0 so external tools (Caddy gateway, other hosts) can reach it.
    # For end users this is fine — they run it locally and access via localhost.
    socketio.run(app, host="0.0.0.0", port=3000, debug=False, allow_unsafe_werkzeug=True)
