# SynapGPU — Live Demo

> ⚠️ **This is the static demo build.** It runs entirely in your browser with
> simulated telemetry and mock LLM responses. For the full app with real
> backend (file uploads, live GPU/CPU/RAM metrics, real LLM chat), see the
> [main branch](https://github.com/ARIKO13/SynapGPU) and follow the
> [Quickstart](https://github.com/ARIKO13/SynapGPU#quickstart).

## What works in this demo

- ✅ Full UI (dashboard, console, chat, benchmark tabs)
- ✅ Drag & drop files (kept in memory only — not persisted)
- ✅ Run / Stop button (state machine transitions)
- ✅ Simulated telemetry (CPU/RAM/SSD/network — animated in browser)
- ✅ Chat with mock LLM responses (pre-written answers to common prompts)
- ✅ Benchmark analyzer (real heuristic scoring of responses)
- ✅ All visualizations (radar chart, bar chart, dimension scores)

## What does NOT work in this demo

- ❌ Real GPU metrics (no `nvidia-smi` in browser)
- ❌ Real LLM chat (no API key, no CORS to LLM provider)
- ❌ File persistence (uploads disappear on page reload)
- ❌ Real device specs (shown values are placeholders)

## Why a demo?

GitHub Pages only serves static files — it cannot run a Python Flask backend.
This demo build lets you preview the UI before deploying the real app.

## Deploy the full app

```bash
git clone https://github.com/ARIKO13/SynapGPU.git
cd SynapGPU
pip install -r requirements.txt
python3 app.py
# → open http://localhost:3000
```

See the [full README](https://github.com/ARIKO13/SynapGPU#readme) for details.
