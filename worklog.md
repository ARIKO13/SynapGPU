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
