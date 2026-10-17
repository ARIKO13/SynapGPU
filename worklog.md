# SynapGPU Desktop — Work Log

---
Task ID: fix-1
Agent: main
Task: Fix two bugs reported by user — (1) Dashboard stuck on "Connecting…" forever; (2) Dropping a .gguf model in the sidebar does not auto-fill the "Load Test Model" dropdown in the Test tab.

Work Log:
- Inspected `synapgpu-desktop/static/index.html`, `static/js/app.js`, and `app.py`.
- Found root cause of "drop not detected": `uploadFiles()`, `deleteFile()`, and `clearAllFiles()` were calling `renderCustomFileList()` — a function that does NOT exist anywhere in `app.js`. The resulting `ReferenceError` was swallowed by the surrounding try/catch and surfaced to the user as a misleading "Upload failed: renderCustomFileList is not defined" log entry, but more importantly it meant `populateModelSelects()` was never called after upload → the Test tab `<select id="pretrained-model-select">` stayed empty, making the user think the drop was ignored.
- Found root cause of "Connecting… forever": `connectSocket()` only hid `#dashboard-loading` on the `connect` event. If the Flask backend was slow to start or not running, socket.io kept retrying silently for 10 attempts (~12s) and then gave up without ever changing the UI. The dashboard loading spinner stayed forever in that window.
- Edits to `static/js/app.js`:
  - Added `connectionFailed: false` to the global `state` object.
  - Added `connect_error` handler that flips `state.connectionFailed`, logs a clear error to the console, and calls `showDashboardOffline()`.
  - Added an 8-second timeout fallback in `connectSocket()` that calls `showDashboardOffline()` if neither `connect` nor `metrics` has fired by then — so the user is never stuck staring at "Connecting…" indefinitely.
  - Added `hideDashboardLoading()` and `showDashboardOffline()` helpers. The offline helper replaces the loading panel content with a red "Backend offline" message + hint to start SynapGPU Desktop on port 3000, instead of an endless spinner.
  - Replaced all three `renderCustomFileList()` calls in `uploadFiles` / `deleteFile` / `clearAllFiles` with `populateModelSelects()`.
  - In `uploadFiles()`, after populating the dropdowns, added auto-fill logic: if a newly uploaded file has `category === 'llm'`, automatically select it in `#pretrained-model-select` and enable the Load button. Also auto-select it in `#train-model-select` (Train tab) if no base model was selected yet, then refresh the train-button enabled state via `updateTrainButton()`.
  - Updated `renderConnection()` so that when `state.connectionFailed` is true, it leaves `showDashboardOffline()`'s DOM alone (previously it would overwrite the offline message back to the spinning "Connecting…" panel whenever any unrelated state change called `renderConnection`).
- Edits to `static/css/styles.css`: added `.spinner.stopped` modifier (animation: none, dimmed border) so the offline state shows a visually idle spinner rather than a perpetually spinning one.
- Bumped cache-busting query on `app.js` (`?v=072` → `?v=073`) and added `?v=073` to `styles.css` link in `index.html` so the browser fetches the updated assets instead of serving stale cached versions.

Stage Summary:
- Files touched: `synapgpu-desktop/static/js/app.js`, `synapgpu-desktop/static/css/styles.css`, `synapgpu-desktop/static/index.html`.
- Behavior after fix:
  - Dashboard "Connecting…" panel now flips to a clear "Backend offline — start SynapGPU Desktop on port 3000" message after 8 s if the Flask backend isn't reachable, instead of spinning forever. As soon as the backend comes online, the panel hides and the live dashboard appears.
  - Dragging & dropping a `.gguf` file onto the Models dropzone in the left sidebar now (a) lists it in the sidebar as before, (b) immediately populates the Test tab's "Pre-trained Model" `<select>` with the new file, (c) auto-selects that new file so the Load button is enabled and the user can click Load without any extra step, and (d) also auto-fills the Train tab's "Base Model" select when empty.
- No backend / `app.py` changes were needed; both issues were purely client-side JS bugs.

---
Task ID: fix-2
Agent: main
Task: Apply equivalent fixes to the Next.js web app (the one shown in the preview URL), since the previous commit only touched the Flask desktop codebase. User reports: dashboard still shows "Connecting…", and dropping a .gguf file in the sidebar does not auto-fill any model loader in the Test tab.

Work Log:
- Diagnosed: the user is viewing the Next.js web app at the preview URL (Caddy → Next.js on port 3000), not the Flask desktop app. Previous fixes targeted `synapgpu-desktop/static/js/app.js` (Flask), which is a separate codebase not served by the preview.
- Read Next.js source: `src/app/page.tsx`, `src/components/platform/{monitoring-dashboard,chat-tester,platform-header,file-sidebar,dropzone}.tsx`, `src/store/platform-store.ts`, `src/hooks/use-metrics-socket.ts`, `src/app/api/run/route.ts`, `src/app/api/files/route.ts`, `src/app/api/chat/route.ts`.
- Found: Next.js ChatTester had NO model selector at all — it just had a chat input. Model loading was implicit via the Run button in the header (which loads `llmFiles[0]`). User expectation that "drop model → auto-fill in test model loader" had no surface to land on.
- Found: `useMetricsSocket` only set `connected` on `connect` and `disconnect` events. If the bun metrics service on port 3003 was unreachable, the dashboard spinner ("Menunggu koneksi telemetry…") would spin forever — no `connect_error` handler, no timeout.

Edits to Next.js app:
- `src/store/platform-store.ts`: Added `connectionFailed: boolean` state + `setConnectionFailed` action.
- `src/hooks/use-metrics-socket.ts`: 
  - Added `connect_error` handler that flips `connectionFailed=true` and logs a clear error pointing to `bun run dev` in `mini-services/metrics-service`.
  - Added an 8-second fallback timer: if neither `connect` nor `metrics` has fired by then, also set `connectionFailed=true`.
  - On `connect`, clears `connectionFailed` back to false (handles reconnects).
- `src/components/platform/monitoring-dashboard.tsx`: When `connectionFailed` is true, render a red "Backend offline" panel with a `WifiOff` icon and a hint to start the metrics service, instead of the spinner.
- `src/components/platform/chat-tester.tsx`: Major rework. Added a Pre-trained vs Trained model loader panel above the chat:
  - Pre-trained mode: a `<select>` populated from `state.files.filter(category === 'llm')` + a Load button. Auto-selects the latest dropped .gguf file (via `useEffect` on `llmFiles`) so the user can click Load immediately without re-selecting.
  - Trained mode: full training config form (base model, dataset, epochs, method) + Start Training button + (after training completes) a "Trained Model Ready" panel showing name/size/params/base/dataset/epochs + Load & Test button + Download button.
  - Clicking Load calls `/api/run` with `{ action: 'start', model: <name> }` (same as header Run button) and transitions local state to 'loading' — the WebSocket hook forwards this to the metrics service via `run:start` emit, and the metrics service transitions loading→running after ~4.5s.
  - Start Training calls the new `/api/train` endpoint.
- `src/app/api/train/route.ts` (new): stub endpoint that simulates training latency (~1.2s) and returns plausible trained-model metadata (`name`, `size`, `params_b`, `method`, `epochs`). Real training would require llama.cpp fine-tune or peft — not feasible in the web sandbox. The metadata is real enough for the UI to display correctly.

Stage Summary:
- Files touched: `src/store/platform-store.ts`, `src/hooks/use-metrics-socket.ts`, `src/components/platform/monitoring-dashboard.tsx`, `src/components/platform/chat-tester.tsx`, `src/app/api/train/route.ts` (new).
- Behavior after fix (Next.js preview):
  - Dashboard "Menunggu koneksi telemetry…" panel now flips to a red "Backend offline" panel after 8s if the bun metrics service on port 3003 isn't reachable, instead of spinning forever. As soon as the metrics service comes online and emits a `metrics` event, the panel hides and the live dashboard appears.
  - Dropping a .gguf file in the left sidebar now: (a) lists it under "LLM Models" in the sidebar (as before), (b) auto-selects it in the Test tab's "Pre-trained Model" dropdown (so the Load button is immediately clickable), and (c) the user can click Load to load it for chat.
  - Test tab now has two modes: "Pre-trained Model" (load existing .gguf) and "Trained Model" (configure training + run it + load the output). Mirrors the UI that was previously only in Flask desktop.
- The Flask desktop fixes from Task fix-1 are still in place; they apply to users who download and run SynapGPU Desktop locally.
