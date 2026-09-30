# SynapGPU

> 🌐 **Live Demo**: https://ariko13.github.io/SynapGPU/
>
> The demo runs entirely in your browser with simulated telemetry and mock
> LLM responses — perfect for previewing the UI. For the full app with real
> backend (file uploads, live GPU/CPU/RAM metrics, real LLM chat), follow
> the [Quickstart](#quickstart) below.

A WebGPU-style notebook platform — drag & drop LLM/dataset files, click Run,
monitor real device telemetry (CPU/RAM/SSD/GPU) in real time, and benchmark
your loaded model against public LLMs.

## Stack

- **Backend**: Python 3 + Flask + Flask-SocketIO + httpx
- **Frontend**: Vanilla HTML / CSS / JavaScript (no framework)
- **Telemetry**: Real system metrics via `psutil`; real GPU metrics via `nvidia-smi` if available
- **Chat**: Streaming responses via ZAI API (OpenAI-compatible)

## Project structure

```
pyapp/
├── app.py                # Flask backend (server, REST API, WebSocket, telemetry)
├── requirements.txt      # Python dependencies
├── static/
│   ├── index.html        # Main page
│   ├── css/styles.css    # Dark professional theme
│   └── js/
│       ├── app.js        # Frontend logic (state, rendering, charts)
│       └── socket.io.min.js  # Socket.IO client (local copy)
└── uploads/              # Uploaded files (runtime, gitignored)
```

## Quickstart

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. (Optional) Configure ZAI API access for chat feature.
#    The server reads the same .z-ai-config file used by the ZAI SDK:
#    Place it at one of these paths:
#      - ./.z-ai-config           (project root)
#      - ~/.z-ai-config           (home directory)
#      - /etc/.z-ai-config        (system)
#    Format:
#    {
#      "baseUrl": "https://internal-api.z.ai/v1",
#      "apiKey": "your-api-key",
#      "chatId": "optional",
#      "userId": "optional",
#      "token": "optional"
#    }
#    Chat tab works without this, but actual LLM responses require it.

# 3. Run the server
python3 app.py

# 4. Open in browser
#    Local:   http://localhost:3000
#    Network: http://<host-ip>:3000
```

## Features

### Drag & drop file upload
Auto-categorizes files by extension:
- **LLM Models**: `.gguf`, `.bin`, `.safetensors`, `.pt`, `.pth`, `.onnx`
- **Datasets**: `.csv`, `.json`, `.jsonl`, `.parquet`, `.txt`, `.tsv`
- **Configs**: `.yaml`, `.yml`, `.toml`, `.ini`, `.conf`

Files are saved to `uploads/` on disk and listed in the sidebar.

### One-click Run / Stop
- Click Run → state transitions `idle → loading → running`
- Click Stop → state transitions `running → stopped → idle`
- Header shows active model name + uptime timer

### Real-time monitoring (WebSocket @ `/socket.io`)
- **Device info card**: CPU model, core count, RAM/Disk totals, GPU model + VRAM
- **Live metrics** (1 Hz):
  - CPU utilization (real, from `psutil`)
  - RAM used/total (real)
  - SSD used/total (real) + read/write throughput (real)
  - Network RX/TX (real)
  - GPU utilization, VRAM, temperature, power draw (real if `nvidia-smi` is available)
- **60s sparkline charts** for RAM and SSD throughput
- **60s line chart** for GPU utilization (only when GPU is available)

### No GPU? Honest fallback
If `nvidia-smi` is not found on the host, the dashboard shows a clear
"No GPU detected" warning and hides GPU metric cards. **No fake numbers.**
Install NVIDIA drivers or run on a GPU machine to see real GPU usage.

### Console
Timestamped log of every platform event:
- File uploads (success / failure, with sizes)
- Run / stop transitions
- Chat completion with benchmark scores
- Connection status changes

### LLM Test Console
- Send prompts to the loaded model
- Responses stream token-by-token via SSE
- Cmd/Ctrl+Enter to send
- Stop button to abort mid-stream
- Active model badge shows loaded file name

### Benchmark
Every chat response is auto-analyzed across 6 dimensions:
- **Reasoning** — density of connective reasoning words + structure
- **Code** — presence of code blocks, function definitions, code lines
- **Math** — math symbols, LaTeX, equations, numbers
- **Knowledge** — response depth and richness
- **Speed** — tokens per second throughput
- **Coherence** — sentence structure and length sanity

Each dimension is scored 0-100 and compared to public LLM benchmarks
(GPT-4, Claude 3.5, Llama 3.1, Mistral, Gemini, Qwen2, Phi-3).

**Verdict** is computed from the closest match:
- "Beats X (+5 pts · 70 vs 65)"
- "On par with X (selisih 2 pts · 68 vs 66)"
- "Slightly below X (3 pts · 65 vs 68)"

Plus a list of all LLMs the user's model beats / loses to.

#### Visualizations
- **Radar chart**: 6-dimension capability profile overlaid with selected LLM
- **Bar chart**: overall score of user's LLM vs all 8 public LLMs, sorted
- **Dimension scores**: per-dimension progress bars with explanations
- **Test history**: every chat prompt + its overall score

## REST API

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Serve the dashboard HTML |
| `/api/device-info` | GET | Detected device specs (CPU, RAM, disk, GPU) |
| `/api/metrics` | GET | One-shot snapshot of current metrics |
| `/api/files` | GET | List uploaded files |
| `/api/files` | POST | Upload files (multipart form-data, `files` field) |
| `/api/files?id=<id>` | DELETE | Delete a file by ID |
| `/api/run` | POST | `{action: "start"\|"stop", model?: "name"}` |
| `/api/chat` | POST | `{messages: [{role, content}]}` — streams NDJSON events |

## WebSocket events

| Event | Direction | Payload |
|---|---|---|
| `metrics` | server → client | Live metrics object (1 Hz) |
| `session:state` | server → client | `{runState, activeModel, runStartedAt}` |
| `run:start` | client → server | `{model?: "name"}` |
| `run:stop` | client → server | (none) |
| `chat:active` | client → server | `true\|false` |

## Production notes

- The bundled Werkzeug dev server is fine for single-user sandbox use.
  For real production, put it behind Gunicorn + nginx.
- `nvidia-smi` is polled every 1s. If your GPU is busy, this may add slight overhead.
- Uploaded files persist on disk in `uploads/`. Clear via the "Clear all" button
  in the sidebar (or delete the directory).
- The benchmark analyzer is heuristic — not a substitute for formal
  benchmarks like MMLU or HumanEval. For real evaluation, swap in a
  standardized eval set.

## License

MIT
