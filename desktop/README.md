# SynapGPU Desktop — Local Device Profiler

> **Desktop version** of SynapGPU. Runs as a local app (Python + Flask) on
> Windows / macOS / Linux. Reads **real device specs** via OS-level access
> (not browser-sandboxed), and fetches live LLM benchmark data from the
> internet to compare against your model.

## What it can do that the web version can't

| Feature | Web (gh-pages) | Desktop (this) |
|---|---|---|
| Real CPU model name | ❌ (browser privacy) | ✅ (via `/proc/cpuinfo`, `wmic`, `sysctl`) |
| Real GPU model (RTX 4060 / Iris / Apple M2) | ⚠️ WebGPU only | ✅ via `nvidia-smi` / `wmic` / `system_profiler` |
| Real total RAM | ❌ (capped at 8GB) | ✅ exact GB |
| Real disk usage (used/free) | ⚠️ storage bucket only | ✅ full disk via `psutil` |
| Live CPU load (real per-core) | ⚠️ synthetic benchmark | ✅ via `psutil.cpu_percent` |
| Live GPU util / VRAM / temp | ❌ | ✅ via `nvidia-smi` |
| Live LLM benchmark data | ⚠️ static snapshot | ✅ fetches from HuggingFace / LMSYS |
| Run local LLM inference | ❌ | ✅ if `llama.cpp` / `ollama` installed |
| File persistence across sessions | ❌ | ✅ uploads/ folder |

## Quickstart (run from source)

```bash
cd synapgpu-desktop
pip install -r requirements.txt
python app.py
# → open http://localhost:3000 in your browser
```

## Build EXE / standalone binary

```bash
# Windows
build.bat

# macOS / Linux
chmod +x build.sh
./build.sh
```

The build produces a `dist/SynapGPU/` folder containing:
- `SynapGPU` (or `SynapGPU.exe` on Windows) — the launcher executable
- All bundled Python + dependencies (no install needed)
- The `static/` folder (HTML/CSS/JS for the UI)

Distribute the entire `dist/SynapGPU/` folder to users. They double-click
the executable, and a browser window opens to `http://localhost:3000`.

## What the desktop app reads

### CPU
- **Linux**: `/proc/cpuinfo` → model name, cache size
- **Windows**: `wmic cpu get name,numberofcores` (or PowerShell `Get-CimInstance`)
- **macOS**: `sysctl -n machdep.cpu.brand_string`
- **All**: `psutil.cpu_percent(interval=1)` for live load, `psutil.cpu_count()` for cores

### GPU
- **NVIDIA**: `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits`
- **AMD**: `rocm-smi --showproductname --showuse --showmeminfo vram --showtemp --showpower` (if ROCm installed)
- **Intel/Apple/Other**: Falls back to CPU-only mode with a "No discrete GPU detected" notice

### RAM
- `psutil.virtual_memory()` → total, used, available (exact bytes)

### Disk
- `psutil.disk_usage('/')` → total, used, free
- `psutil.disk_io_counters()` → real read/write throughput (MB/s)

### Network
- `psutil.net_io_counters()` → bytes sent/received (converted to Mbps)

### Live LLM benchmark data
The desktop version fetches benchmark data from these public sources at
startup (and refreshes every hour while running):
- **Open LLM Leaderboard**: https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard
- **LMSYS Chatbot Arena**: https://chat.lmsys.org/?leaderboard
- **Artificial Analysis**: https://artificialanalysis.ai/

If the network is offline, it falls back to a static snapshot of mid-2024
scores (the same as the web version uses).

## Optional: Local LLM inference

If you want to actually run inference (not just profile device specs), the
desktop app can talk to:
- **Ollama**: `http://localhost:11434/api/chat` (auto-detected if running)
- **llama.cpp server**: `http://localhost:8080/completion` (auto-detected if running)
- **LM Studio**: `http://localhost:1234/v1/chat/completions` (OpenAI-compatible)

Just install any of those, load a model, and SynapGPU Desktop will detect
it automatically and route chat requests there. No more mock responses!

## Files

```
synapgpu-desktop/
├── app.py              # Main Flask server (real device detection + LLM fetch)
├── llm_fetch.py        # Live LLM benchmark data fetcher (HuggingFace, LMSYS)
├── requirements.txt
├── build.sh            # macOS/Linux PyInstaller build script
├── build.bat           # Windows PyInstaller build script
├── SynapGPU.spec       # PyInstaller spec file
├── README.md
└── static/
    ├── index.html      # Same UI as web version
    ├── css/styles.css
    └── js/
        ├── app.js              # Frontend logic (talks to local backend)
        └── socket.io.min.js
```

## License

MIT — same as the main SynapGPU repo.
