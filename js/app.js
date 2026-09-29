/* SynapGPU — Live device profiler (GitHub Pages build)
 *
 * Reads REAL specs from the browser's host device via Web APIs:
 *   - GPU via navigator.gpu.requestAdapter().requestAdapterInfo()
 *   - CPU cores via navigator.hardwareConcurrency
 *   - RAM via navigator.deviceMemory (Chrome)
 *   - Disk usage via navigator.storage.estimate()
 *   - Network via Network Information API
 *   - Battery via Battery API
 *   - CPU load via synthetic benchmark (real-ish)
 *
 * What CANNOT be read from a browser (security sandbox):
 *   - Per-process CPU/memory usage like a real OS task manager
 *
 * But for a public, no-install web app, this is as close as it gets.
 */

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  files: [
    { id: 'demo-1', name: 'llama-3.1-8b.gguf', sizeBytes: 4920000000, humanSize: '4.6 GB', category: 'llm', uploadedAt: Date.now() - 5 * 60000 },
    { id: 'demo-2', name: 'alpaca-instruct.jsonl', sizeBytes: 184000000, humanSize: '175.5 MB', category: 'dataset', uploadedAt: Date.now() - 4 * 60000 },
    { id: 'demo-3', name: 'config.yaml', sizeBytes: 412, humanSize: '412 B', category: 'config', uploadedAt: Date.now() - 3 * 60000 },
  ],
  runState: 'idle',
  activeModel: null,
  runStartedAt: null,
  metrics: null,
  metricsHistory: [],
  gpuUtilHistory: [],
  ssdReadHistory: [],
  cpuUtilHistory: [],
  connected: true,
  consoleLines: [],
  chatMessages: [],
  chatStreaming: false,
  chatAbortController: null,
  uptimeTimer: null,
  benchmarkResults: [],
  radarCompareKey: 'gpt4',
  // Real device info — detected on load
  deviceInfo: null,
  // CPU benchmark state (for live utilization estimate)
  cpuBenchmarkResult: 0,
  cpuBenchmarkPrev: 0,
  // Storage estimate (disk)
  storageEstimate: null,
  // Battery
  battery: null,
  // Network
  network: null,
};

const MAX_HISTORY = 60;
const MAX_CONSOLE = 200;
const MAX_CHAT = 100;
const MAX_BENCHMARK = 50;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function log(text, level = 'info') {
  state.consoleLines.push({ id: uid(), ts: Date.now(), level, text });
  if (state.consoleLines.length > MAX_CONSOLE) state.consoleLines.shift();
  renderConsole();
}

// ===========================================================================
// REAL DEVICE DETECTION — this is the core of the public web app.
// Each visitor's device gets profiled via standard Web APIs.
// ===========================================================================

/**
 * Detect GPU via WebGPU API. Returns adapter info if WebGPU is supported,
 * else null. Falls back gracefully — many older devices don't have WebGPU.
 */
async function detectGPU() {
  if (!('gpu' in navigator)) {
    return { available: false, reason: 'WebGPU API not supported in this browser' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { available: false, reason: 'No compatible GPU adapter found' };
    }
    // adapter.requestAdapterInfo() is the standard way to get vendor/device.
    // Some browsers (older Chrome) don't have it; fall back to adapter.info.
    let info = null;
    try {
      info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
    } catch (e) {
      info = null;
    }
    if (!info) {
      // Best-effort: get whatever the adapter exposes.
      return {
        available: true,
        vendor: 'Unknown',
        architecture: 'Unknown',
        device: 'Unknown',
        description: 'WebGPU adapter (details unavailable in this browser)',
      };
    }
    const desc = [info.vendor, info.architecture, info.device].filter(Boolean).join(' ');
    return {
      available: true,
      vendor: info.vendor || 'Unknown',
      architecture: info.architecture || 'Unknown',
      device: info.device || 'Unknown',
      description: desc || 'WebGPU GPU',
    };
  } catch (e) {
    return { available: false, reason: `WebGPU error: ${e.message}` };
  }
}

/**
 * Detect CPU model. The browser doesn't expose CPU model name directly for
 * privacy reasons. We can infer architecture + platform from userAgentData
 * or userAgent, and core count from hardwareConcurrency.
 */
function detectCPU() {
  const cores = navigator.hardwareConcurrency || 0;

  // High-entropy values (UA Client Hints API) — Chromium-based browsers
  let arch = 'Unknown';
  let platform = 'Unknown';
  let bitness = '';
  if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    // This is async but we'll handle it separately below
  }

  // Quick parse of navigator.platform / userAgent
  const ua = navigator.userAgent;
  if (/Mac/i.test(navigator.platform)) platform = 'macOS';
  else if (/Win/i.test(navigator.platform)) platform = 'Windows';
  else if (/Linux/i.test(navigator.platform)) platform = 'Linux';
  else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'iOS';
  else if (/Android/i.test(ua)) platform = 'Android';

  // Architecture hints
  if (/arm|aarch64/i.test(ua)) arch = 'ARM';
  else if (/x86_64|amd64|WOW64|Win64/i.test(ua)) arch = 'x86_64';
  else if (/x86|i686/i.test(ua)) arch = 'x86';

  // Try to get more specific via UA-CH (Chrome)
  // We return a placeholder model here; the full detection happens async.
  return {
    model: `${platform} ${arch} device`,
    coresLogical: cores,
    coresPhysical: cores,  // Browser doesn't expose physical vs logical; treat as same
    platform,
    architecture: arch,
  };
}

async function detectCPUAsync() {
  const cpu = detectCPU();
  if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    try {
      const hev = await navigator.userAgentData.getHighEntropyValues([
        'architecture', 'bitness', 'platform', 'platformVersion', 'model',
        'uaFullVersion', 'fullVersionList',
      ]);
      if (hev.architecture) cpu.architecture = hev.architecture.toUpperCase();
      if (hev.bitness) cpu.bitness = hev.bitness;
      if (hev.platform) cpu.platform = hev.platform;
      if (hev.platformVersion) cpu.platformVersion = hev.platformVersion;
      if (hev.model) cpu.model = hev.model;
      // Build a human-readable model string
      const parts = [];
      if (hev.platform) parts.push(hev.platform);
      if (hev.platformVersion) parts.push(hev.platformVersion.split('.')[0]);
      if (hev.architecture) parts.push(`${hev.architecture}${hev.bitness || ''}`);
      if (parts.length) cpu.model = parts.join(' ');
    } catch (e) { /* fall back to sync detection */ }
  }
  return cpu;
}

/**
 * Detect total RAM. navigator.deviceMemory is Chrome-only and capped at 8GB
 * (privacy). On other browsers, we can't know the exact amount but we can
 * show "N+ GB" based on the cap.
 */
function detectRAM() {
  const mem = navigator.deviceMemory;  // Chrome only, returns 0.25/0.5/1/2/4/8 (capped)
  if (typeof mem === 'number' && mem > 0) {
    // If browser reports 8, the device could have 8GB or more (capped at 8).
    return {
      totalGb: mem,
      cappedAtBrowser: mem === 8,
      displayTotal: mem === 8 ? '8+ GB' : `${mem} GB`,
    };
  }
  return {
    totalGb: 0,
    displayTotal: 'Unknown',
    unavailable: true,
  };
}

/**
 * Detect disk usage via Storage API. navigator.storage.estimate() returns
 * { quota, usage } where quota is the storage bucket limit (usually a
 * fraction of free disk space) and usage is what this origin is using.
 * The total disk size is inferred from quota (rough approximation).
 */
async function detectStorage() {
  if (!navigator.storage || !navigator.storage.estimate) {
    return { unavailable: true };
  }
  try {
    const est = await navigator.storage.estimate();
    // quota is usually a fraction (10%–60%) of free disk space, but it gives
    // us a hint about available storage. Real total disk is not exposed.
    return {
      quota: est.quota,        // bytes available to this origin
      usage: est.usage,        // bytes used by this origin
      quotaGb: est.quota ? est.quota / (1024 ** 3) : 0,
      usageGb: est.usage ? est.usage / (1024 ** 3) : 0,
      // Free space estimate (browser's storage bucket — not real disk)
      freeGb: est.quota && est.usage ? (est.quota - est.usage) / (1024 ** 3) : 0,
    };
  } catch (e) {
    return { unavailable: true };
  }
}

/**
 * Detect network connection type and speed.
 */
function detectNetwork() {
  if (!('connection' in navigator) || !navigator.connection) {
    return { unavailable: true };
  }
  const conn = navigator.connection;
  return {
    effectiveType: conn.effectiveType || 'unknown',  // 'slow-2g'|'2g'|'3g'|'4g'
    downlink: conn.downlink || 0,      // Mbps (estimated)
    rtt: conn.rtt || 0,                // ms (estimated round-trip time)
    saveData: conn.saveData || false,
  };
}

/**
 * Detect battery. Returns null if unsupported (most desktop browsers,
 * iOS Safari, etc.).
 */
async function detectBattery() {
  if (!('getBattery' in navigator)) {
    return { unavailable: true };
  }
  try {
    const batt = await navigator.getBattery();
    const update = () => ({
      level: Math.round(batt.level * 100),
      charging: batt.charging,
      chargingTime: batt.chargingTime,
      dischargingTime: batt.dischargingTime,
    });
    state.battery = update();
    batt.addEventListener('levelchange', () => { state.battery = update(); });
    batt.addEventListener('chargingchange', () => { state.battery = update(); });
    return state.battery;
  } catch (e) {
    return { unavailable: true };
  }
}

/**
 * Master device info — calls all detectors and assembles the result.
 * Uses Promise.allSettled so a failure in one detector (e.g. Battery API
 * not supported) doesn't break the others.
 */
async function detectDeviceInfo() {
  log('Detecting device specs…', 'info');
  const results = await Promise.allSettled([
    detectGPU(),
    detectCPUAsync(),
    detectStorage(),
    detectBattery(),
  ]);
  const gpu = results[0].status === 'fulfilled' ? results[0].value : { available: false, reason: 'detection failed' };
  const cpu = results[1].status === 'fulfilled' ? results[1].value : detectCPU();
  const storage = results[2].status === 'fulfilled' ? results[2].value : { unavailable: true };
  const battery = results[3].status === 'fulfilled' ? results[3].value : { unavailable: true };
  const ram = detectRAM();
  const network = detectNetwork();
  const screen = {
    width: window.screen.width,
    height: window.screen.height,
    colorDepth: window.screen.colorDepth,
    pixelRatio: window.devicePixelRatio,
  };

  const info = {
    cpu, ram, disk: storage, gpu, network, battery, screen,
    userAgent: navigator.userAgent,
    browser: detectBrowser(),
    language: navigator.language,
    online: navigator.onLine,
  };

  if (gpu.available) {
    log(`GPU detected: ${gpu.description}`, 'success');
  } else {
    log(`GPU: ${gpu.reason || 'not available'}`, 'warn');
  }
  log(`CPU: ${cpu.model} (${cpu.coresLogical} cores)`, 'info');
  log(`RAM: ${ram.displayTotal}${ram.cappedAtBrowser ? ' (capped at 8GB by browser)' : ''}`, 'info');
  if (!storage.unavailable) {
    log(`Storage: ${humanSize(storage.usage)} / ${humanSize(storage.quota)} available to this site`, 'info');
  }
  if (!network.unavailable) {
    log(`Network: ${network.effectiveType} · ${network.downlink} Mbps · ${network.rtt}ms RTT`, 'info');
  }
  if (!battery.unavailable) {
    log(`Battery: ${battery.level}%${battery.charging ? ' (charging)' : ''}`, 'info');
  }
  return info;
}

function detectBrowser() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return { name: 'Edge', version: (ua.match(/Edg\/([\d.]+)/) || [])[1] };
  if (/OPR\//.test(ua)) return { name: 'Opera', version: (ua.match(/OPR\/([\d.]+)/) || [])[1] };
  if (/Chrome\//.test(ua)) return { name: 'Chrome', version: (ua.match(/Chrome\/([\d.]+)/) || [])[1] };
  if (/Firefox\//.test(ua)) return { name: 'Firefox', version: (ua.match(/Firefox\/([\d.]+)/) || [])[1] };
  if (/Safari\//.test(ua)) return { name: 'Safari', version: (ua.match(/Version\/([\d.]+)/) || [])[1] };
  return { name: 'Unknown', version: '' };
}

// ===========================================================================
// CPU LOAD ESTIMATE — synthetic benchmark (10ms every 2s)
// ===========================================================================

/**
 * Estimate CPU load by running a fixed-workload loop and measuring throughput.
 * Higher throughput = idle CPU; lower throughput = busy CPU (or slow CPU).
 * The number itself isn't % utilization, but it trends with load.
 *
 * We normalize to a 0-100 "load index" where 100 = idle (fast) and 0 = fully busy (slow).
 */
function runCpuBenchmark() {
  const start = performance.now();
  const iterations = 200000;
  let sum = 0;
  for (let i = 0; i < iterations; i++) {
    sum += Math.sqrt(i) * Math.sin(i * 0.001);
  }
  const elapsed = performance.now() - start;
  // We use elapsed time as a proxy for CPU load: short elapsed = idle CPU,
  // long elapsed = busy CPU. Baseline: take the min elapsed observed as 100% idle.
  // For demo, we'll just use elapsed (in ms) and convert to a load score.
  // Lower elapsed = better performance = lower "load".
  // Save raw result; compute "load %" by comparison with rolling baseline.
  return elapsed;
}

setInterval(() => {
  const elapsed = runCpuBenchmark();
  state.cpuBenchmarkResult = elapsed;
  // Baseline = best (fastest) time we've seen in this session.
  if (!state.cpuBenchmarkBaseline || elapsed < state.cpuBenchmarkBaseline) {
    state.cpuBenchmarkBaseline = elapsed;
  }
  // Estimate load % as how much slower than baseline.
  // load% = (current - baseline) / baseline * 100, capped at 0-100.
  const baseline = state.cpuBenchmarkBaseline || elapsed;
  const loadPct = baseline > 0
    ? Math.min(100, Math.max(0, ((elapsed - baseline) / baseline) * 100))
    : 0;
  state.cpuBenchmarkLoad = loadPct;
}, 2000);

// ===========================================================================
// Live metrics broadcast — simulated telemetry built on real device specs
// ===========================================================================

const sim = {
  cpuUtil: 3.5,
  ramUsed: 0,
  ssdUsed: 0,
  ssdRead: 0,
  ssdWrite: 0,
  netRx: 0.5,
  netTx: 0.5,
};

function drift(prev, target, step) {
  const noise = (Math.random() - 0.5) * step;
  return prev + (target - prev) * 0.18 + noise;
}

function generateMetrics() {
  // Use REAL CPU benchmark result if available, otherwise use a small idle value.
  const cpuUtil = state.cpuBenchmarkLoad != null
    ? Math.min(100, state.cpuBenchmarkLoad + (state.runState === 'running' ? 40 : 0))
    : Math.random() * 3;

  // RAM used — we know total from deviceInfo, but used is browser-restricted.
  // We can use performance.memory (Chrome-only) if available; otherwise simulate.
  let ramUsed;
  if (performance.memory) {
    ramUsed = performance.memory.usedJSHeapSize / (1024 ** 3);
  } else if (state.deviceInfo && state.deviceInfo.ram.totalGb) {
    // Simulate based on run state — no real per-process memory available.
    let target = state.deviceInfo.ram.totalGb * 0.3;
    if (state.runState === 'loading') target = state.deviceInfo.ram.totalGb * 0.5;
    if (state.runState === 'running') target = state.deviceInfo.ram.totalGb * 0.65;
    ramUsed = drift(sim.ramUsed, target, 0.1);
  } else {
    ramUsed = 0;
  }
  sim.ramUsed = ramUsed;

  // SSD throughput — simulate (browser can't measure disk I/O)
  let ssdReadTarget, ssdWriteTarget;
  if (state.runState === 'loading') {
    ssdReadTarget = 850; ssdWriteTarget = 30;
  } else if (state.runState === 'running') {
    ssdReadTarget = 80; ssdWriteTarget = 35;
  } else {
    ssdReadTarget = Math.random() * 12;
    ssdWriteTarget = Math.random() * 6;
  }
  sim.ssdRead = Math.max(0, drift(sim.ssdRead, ssdReadTarget, 60));
  sim.ssdWrite = Math.max(0, drift(sim.ssdWrite, ssdWriteTarget, 25));

  // Network — use REAL Network Information API if available
  let netRx, netTx;
  if (state.deviceInfo && state.deviceInfo.network && !state.deviceInfo.network.unavailable) {
    netRx = state.deviceInfo.network.downlink || 0;
    // TX not exposed; use a small fraction
    netTx = netRx * 0.1;
  } else {
    netRx = drift(sim.netRx, 0.5, 1.0);
    netTx = drift(sim.netTx, 0.3, 0.8);
  }
  if (state.chatStreaming) { netRx += 8; netTx += 4; }

  const now = Date.now();
  return {
    ts: now,
    cpu: { utilization: cpuUtil },
    gpu: state.deviceInfo?.gpu?.available
      ? {
          available: true,
          utilization: 0,  // WebGPU doesn't expose live util without running compute
          memoryUsedGb: 0,
          memoryTotalGb: 0,
          tempC: 0,
          powerW: 0,
        }
      : { available: false },
    ram: {
      usedGb: ramUsed,
      totalGb: state.deviceInfo?.ram?.totalGb || 0,
      displayTotal: state.deviceInfo?.ram?.displayTotal || (state.deviceInfo?.ram?.totalGb ? `${state.deviceInfo.ram.totalGb} GB` : 'Unknown'),
    },
    ssd: {
      // Real storage numbers from navigator.storage.estimate()
      usedGb: state.storageEstimate?.usageGb || 0,
      totalGb: state.storageEstimate?.quotaGb || 0,
      readMbps: sim.ssdRead,
      writeMbps: sim.ssdWrite,
    },
    net: { rxMbps: netRx, txMbps: netTx },
    gpu_available: !!(state.deviceInfo?.gpu?.available),
    battery: state.battery,
  };
}

// Refresh storage estimate every 10s (changes when user uploads files via the demo)
setInterval(async () => {
  if (navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      state.storageEstimate = {
        quota: est.quota,
        usage: est.usage,
        quotaGb: est.quota ? est.quota / (1024 ** 3) : 0,
        usageGb: est.usage ? est.usage / (1024 ** 3) : 0,
      };
    } catch (e) { /* ignore */ }
  }
}, 10000);

// ===========================================================================
// "Connection" — in this build we don't need a backend, so we just simulate
// the connect/disconnect handshake locally.
// ===========================================================================
function connectSocket() {
  setTimeout(() => {
    state.connected = true;
    log('Live device telemetry started.', 'success');
    renderConnection();
    renderDeviceInfo();
    // Kick off the live metrics loop (1 Hz).
    setInterval(() => {
      state.metrics = generateMetrics();
      state.metricsHistory.push(state.metrics);
      if (state.metricsHistory.length > MAX_HISTORY) state.metricsHistory.shift();
      state.gpuUtilHistory.push(state.metrics.gpu.available ? state.metrics.gpu.utilization : 0);
      state.ssdReadHistory.push(state.metrics.ssd.readMbps);
      if (state.ssdReadHistory.length > MAX_HISTORY) state.ssdReadHistory.shift();
      renderMetrics();
    }, 1000);
  }, 600);
}

// ===========================================================================
// File management (in-browser only — kept in memory, not persisted)
// ===========================================================================
function uploadFiles(fileList) {
  const files = Array.from(fileList);
  if (files.length === 0) return;
  log(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`, 'info');
  let addedCount = 0;
  let addedBytes = 0;
  files.forEach((f) => {
    const ext = f.name.split('.').pop().toLowerCase();
    let category = 'other';
    if (['gguf', 'bin', 'safetensors', 'pt', 'pth', 'onnx'].includes(ext)) category = 'llm';
    else if (['csv', 'json', 'jsonl', 'parquet', 'txt', 'tsv'].includes(ext)) category = 'dataset';
    else if (['yaml', 'yml', 'toml', 'ini', 'conf'].includes(ext)) category = 'config';
    state.files.push({
      id: uid(),
      name: f.name,
      sizeBytes: f.size,
      humanSize: humanSize(f.size),
      category,
      uploadedAt: Date.now(),
    });
    addedCount++;
    addedBytes += f.size;
  });
  log(`Uploaded ${addedCount} file${addedCount > 1 ? 's' : ''} (${humanSize(addedBytes)}).`, 'success');
  renderFiles();
  renderRunState();
}

function deleteFile(id) {
  state.files = state.files.filter((f) => f.id !== id);
  log(`File deleted.`, 'info');
  renderFiles();
  renderRunState();
}

function clearAllFiles() {
  state.files = [];
  log('All files cleared.', 'info');
  renderFiles();
  renderRunState();
}

function refreshFiles() { /* no-op in demo */ }

// ===========================================================================
// Run control (simulated state machine)
// ===========================================================================
function handleRun() {
  const llmFile = state.files.find((f) => f.category === 'llm');
  const model = llmFile ? llmFile.name : null;
  log(`Run: ${model ?? '(no model)'}`, 'info');
  state.runState = 'loading';
  state.activeModel = model;
  state.runStartedAt = Date.now();
  renderRunState();
  setTimeout(() => {
    if (state.runState === 'loading') {
      state.runState = 'running';
      renderRunState();
    }
  }, 3000);
}

function handleStop() {
  log('Stop.', 'warn');
  state.runState = 'stopped';
  renderRunState();
  setTimeout(() => {
    if (state.runState === 'stopped') {
      state.runState = 'idle';
      renderRunState();
    }
  }, 1500);
}

// ===========================================================================
// Chat (mock LLM responses)
// ===========================================================================
const MOCK_RESPONSES = [
  { match: /webgpu|web ?gpu/i,
    text: "WebGPU is a modern web API that exposes GPU compute and graphics capabilities directly in the browser. Unlike WebGL, it's built on top of Vulkan/Metal/D3D12 and supports general-purpose compute shaders, making it viable for LLM inference via projects like transformers.js and wllama.\n\nKey advantages:\n- Direct GPU memory access from JavaScript\n- Compute shaders (not just graphics)\n- Lower overhead than WebGL\n\nIn SynapGPU, we use WebGPU to detect your GPU model — that's why your device info shows up in the Device card!" },
  { match: /quicksort|sort algorithm/i,
    text: "Here's a clean Python quicksort implementation:\n\n```python\ndef quicksort(arr):\n    \"\"\"Sort a list in-place using quicksort.\"\"\"\n    if len(arr) <= 1:\n        return arr\n    pivot = arr[len(arr) // 2]\n    left = [x for x in arr if x < pivot]\n    middle = [x for x in arr if x == pivot]\n    right = [x for x in arr if x > pivot]\n    return quicksort(left) + middle + quicksort(right)\n\nprint(quicksort([3, 6, 8, 10, 1, 2, 1]))  # [1, 1, 2, 3, 6, 8, 10]\n```\n\nTime complexity: O(n log n) average, O(n²) worst case." },
  { match: /integral|x\^2|math|calculate/i,
    text: "To compute ∫₀³ x² dx:\n\n**Step 1: Antiderivative**\nThe antiderivative of xⁿ is xⁿ⁺¹/(n+1).\nFor x², n=2, so antiderivative = x³/3.\n\n**Step 2: Apply bounds**\n∫₀³ x² dx = [x³/3]₀³ = (3³/3) - (0³/3) = 27/3 - 0 = **9**" },
  { match: /startup|idea|name/i,
    text: "Here are 5 startup name ideas in the AI space:\n\n1. **SynapStack** — neural network infra platform\n2. **TokenForge** — fine-tuning API service\n3. **GPUHive** — distributed inference marketplace\n4. **QuantaLabs** — applied AI research consultancy\n5. **Vexa AI** — voice-first assistant platform" },
  { match: /hello|hi|halo/i,
    text: "Hello! This is a mock response from the SynapGPU public demo. Your real device specs are shown in the Device card — that's the actual point of this app!\n\nFor real LLM responses, deploy the Python backend (see README)." },
];

function pickMockResponse(prompt) {
  for (const r of MOCK_RESPONSES) if (r.match.test(prompt)) return r.text;
  return `This is a simulated response. The SynapGPU public demo runs entirely in your browser — your device specs are real, but the chat uses pre-written mock answers.\n\nFor real LLM responses, deploy the Flask backend (see README).\n\nYour prompt was: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`;
}

function sendMessage() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || state.runState !== 'running' || state.chatStreaming) return;

  const userMsg = { id: uid(), role: 'user', content: text, ts: Date.now() };
  const assistantId = uid();
  const assistantMsg = { id: assistantId, role: 'assistant', content: '', ts: Date.now(), streaming: true };
  state.chatMessages.push(userMsg, assistantMsg);
  if (state.chatMessages.length > MAX_CHAT) state.chatMessages = state.chatMessages.slice(-MAX_CHAT);

  input.value = '';
  $('#chat-error').classList.add('hidden');
  state.chatStreaming = true;
  renderChatMessages();
  renderChatInput();

  const fullResponse = pickMockResponse(text);
  const tokens = fullResponse.match(/\S+\s*|\s+/g) || [fullResponse];
  let i = 0;
  const startedAt = Date.now();

  const tick = () => {
    if (i >= tokens.length) {
      const msg = state.chatMessages.find((m) => m.id === assistantId);
      if (msg) { msg.streaming = false; msg.latencyMs = Date.now() - startedAt; }
      const analysis = analyzeResponse(text, fullResponse, msg.latencyMs);
      state.benchmarkResults.push({
        id: uid(), prompt: text, response: fullResponse, analysis, ts: Date.now(),
      });
      if (state.benchmarkResults.length > MAX_BENCHMARK) {
        state.benchmarkResults = state.benchmarkResults.slice(-MAX_BENCHMARK);
      }
      renderBenchmark();
      log(`Scored ${analysis.overall}/100`, 'info');
      state.chatStreaming = false;
      renderChatInput();
      renderChatMessages();
      return;
    }
    const msg = state.chatMessages.find((m) => m.id === assistantId);
    if (msg) msg.content += tokens[i];
    i++;
    renderChatMessages();
    setTimeout(tick, 25 + Math.random() * 40);
  };
  setTimeout(tick, 350);
}

function stopChat() {
  state.chatStreaming = false;
  state.chatMessages.forEach((m) => { if (m.streaming) m.streaming = false; });
  renderChatMessages();
  renderChatInput();
  log('Chat aborted.', 'warn');
}

function clearChat() { state.chatMessages = []; renderChatMessages(); }

// ===========================================================================
// Benchmark analyzer (unchanged from real app)
// ===========================================================================
const BENCHMARKS = {
  gpt4: { name: "GPT-4", color: "#10a37f", mmlu: 86.4, humaneval: 67.0, gsm8k: 92.0, math: 42.5, reasoning: 90, speed_tps: 30 },
  claude35: { name: "Claude 3.5 Sonnet", color: "#d97706", mmlu: 88.7, humaneval: 92.0, gsm8k: 96.4, math: 71.1, reasoning: 92, speed_tps: 80 },
  llama3_70b: { name: "Llama 3.1 70B", color: "#0866ff", mmlu: 82.0, humaneval: 80.0, gsm8k: 84.5, math: 50.0, reasoning: 85, speed_tps: 100 },
  mistral_large: { name: "Mistral Large 2", color: "#ff6b35", mmlu: 84.0, humaneval: 81.0, gsm8k: 81.0, math: 45.0, reasoning: 82, speed_tps: 60 },
  llama3_8b: { name: "Llama 3.1 8B", color: "#7c3aed", mmlu: 66.0, humaneval: 72.0, gsm8k: 84.0, math: 30.0, reasoning: 65, speed_tps: 150 },
  gemini15: { name: "Gemini 1.5 Pro", color: "#4285f4", mmlu: 85.0, humaneval: 84.0, gsm8k: 91.0, math: 67.0, reasoning: 88, speed_tps: 50 },
  qwen2_72b: { name: "Qwen2 72B", color: "#06b6d4", mmlu: 84.0, humaneval: 86.0, gsm8k: 89.0, math: 50.0, reasoning: 84, speed_tps: 90 },
  phi3_medium: { name: "Phi-3 Medium", color: "#ec4899", mmlu: 78.0, humaneval: 62.0, gsm8k: 91.0, math: 45.0, reasoning: 75, speed_tps: 120 },
};

const DIMENSIONS = [
  { key: 'reasoning', label: 'Reasoning', hint: 'Logical & multi-step thinking' },
  { key: 'code', label: 'Code', hint: 'Code blocks & function defs' },
  { key: 'math', label: 'Math', hint: 'Numbers, formulas, equations' },
  { key: 'knowledge', label: 'Knowledge', hint: 'Depth & richness of content' },
  { key: 'speed', label: 'Speed', hint: 'Throughput (tokens/sec)' },
  { key: 'coherence', label: 'Coherence', hint: 'Sentence structure sanity' },
];

function analyzeResponse(userMsg, assistantMsg, latencyMs) {
  const promptLen = userMsg.length;
  const responseLen = assistantMsg.length;
  const promptWords = Math.max(1, userMsg.trim().split(/\s+/).length);
  const responseWords = Math.max(1, assistantMsg.trim().split(/\s+/).length);
  const responseTokens = Math.max(1, Math.round(responseLen / 4));
  const tps = latencyMs > 0 ? (responseTokens / latencyMs) * 1000 : 0;
  const codeBlocks = (assistantMsg.match(/```[\s\S]*?```/g) || []).length;
  const inlineCode = (assistantMsg.match(/`[^`\n]+`/g) || []).length;
  const hasFunction = /\b(def |function |func |class |public |private |return |import |from )/.test(assistantMsg);
  const codeLines = (assistantMsg.match(/^\s*(if |for |while |return |print|def |class |import |from |const |let |var )/gm) || []).length;
  const hasMathSymbols = /[∑∫π√≠≤≥±×÷∞²³]/.test(assistantMsg);
  const hasLatex = /\\(frac|sqrt|int|sum|alpha|beta|gamma|theta)/.test(assistantMsg);
  const hasNumbers = /\d+(\.\d+)?/.test(assistantMsg);
  const hasEquations = /[^=!<>]=[^\s=]/.test(assistantMsg);
  const reasoningWords = (assistantMsg.toLowerCase().match(/\b(karena|oleh karena itu|sebab|akibatnya|pertama|kedua|ketiga|selanjutnya|namun|akan tetapi|sebaliknya|sehingga|makanya|jadi|therefore|because|thus|hence|consequently|first|second|third|however|moreover|furthermore|in conclusion|step|analysis|reason)\b/g) || []).length;
  const sentenceCount = (assistantMsg.match(/[.!?\n]+/g) || []).length;
  const avgSentenceLen = sentenceCount > 0 ? responseWords / sentenceCount : responseWords;
  const responseDepth = responseWords / promptWords;
  const reasoningDensity = reasoningWords / Math.max(1, responseWords);
  const reasoningScore = Math.min(100, Math.round(reasoningDensity * 250 + (sentenceCount > 3 ? 25 : sentenceCount * 8) + (responseWords > 50 ? 15 : 0) + (responseWords > 150 ? 10 : 0)));
  const codeScore = Math.min(100, Math.round(codeBlocks * 30 + Math.min(20, codeLines * 4) + (hasFunction ? 20 : 0) + Math.min(10, inlineCode * 2)));
  const mathScore = Math.min(100, Math.round((hasMathSymbols ? 35 : 0) + (hasLatex ? 30 : 0) + (hasEquations ? 20 : 0) + (hasNumbers ? 15 : 0)));
  const knowledgeScore = Math.min(100, Math.round(Math.min(35, responseWords / 4) + Math.min(25, responseLen / 60) + Math.min(20, avgSentenceLen) + Math.min(20, responseDepth * 5)));
  const speedScore = Math.min(100, Math.round(tps));
  const coherent = responseLen > 50 && sentenceCount >= 1 && avgSentenceLen < 30;
  const coherenceScore = Math.min(100, Math.round((coherent ? 35 : 0) + (responseWords > 30 ? 20 : 0) + (sentenceCount > 2 ? 20 : sentenceCount * 7) + (avgSentenceLen > 5 && avgSentenceLen < 25 ? 25 : 10)));
  const scores = { reasoning: reasoningScore, code: codeScore, math: mathScore, knowledge: knowledgeScore, speed: speedScore, coherence: coherenceScore };
  const overall = Math.round((reasoningScore + codeScore + mathScore + knowledgeScore + speedScore + coherenceScore) / 6);
  return { promptLen, responseLen, responseWords, responseTokens, latencyMs, tps: Math.round(tps * 10) / 10, codeBlocks, codeLines, inlineCode, hasFunction, hasMathSymbols, hasLatex, hasNumbers, hasEquations, reasoningWords, sentenceCount, avgSentenceLen, scores, overall, timestamp: Date.now() };
}

function llmBenchmarkToDimensions(b) {
  if (!b) return null;
  return { reasoning: b.reasoning, code: b.humaneval, math: Math.round((b.gsm8k + b.math) / 2), knowledge: b.mmlu, speed: Math.min(100, b.speed_tps), coherence: Math.round((b.mmlu + b.reasoning) / 2) };
}

function llmOverallScore(b) {
  if (!b) return 0;
  const d = llmBenchmarkToDimensions(b);
  return Math.round((d.reasoning + d.code + d.math + d.knowledge + d.speed + d.coherence) / 6);
}

function aggregateUserScores() {
  if (state.benchmarkResults.length === 0) return null;
  const sum = { reasoning: 0, code: 0, math: 0, knowledge: 0, speed: 0, coherence: 0 };
  state.benchmarkResults.forEach((r) => { Object.keys(sum).forEach((k) => { sum[k] += r.analysis.scores[k]; }); });
  const n = state.benchmarkResults.length;
  Object.keys(sum).forEach((k) => { sum[k] = Math.round(sum[k] / n); });
  return sum;
}

function aggregateUserOverall() {
  if (state.benchmarkResults.length === 0) return 0;
  const s = aggregateUserScores();
  return Math.round((s.reasoning + s.code + s.math + s.knowledge + s.speed + s.coherence) / 6);
}

function computeVerdict() {
  const userOverall = aggregateUserOverall();
  if (userOverall === 0) return null;
  const comparisons = Object.entries(BENCHMARKS).map(([key, b]) => {
    const bOverall = llmOverallScore(b);
    return { key, name: b.name, color: b.color, overall: bOverall, diff: userOverall - bOverall };
  });
  comparisons.sort((a, b) => b.overall - a.overall);
  const closest = comparisons.reduce((best, c) => !best || Math.abs(c.diff) < Math.abs(best.diff) ? c : best, null);
  const beats = comparisons.filter((c) => c.diff > 0).sort((a, b) => a.diff - b.diff);
  const losesTo = comparisons.filter((c) => c.diff < 0).sort((a, b) => b.diff - a.diff);
  return { userOverall, comparisons, closest, beats, losesTo };
}

// ===========================================================================
// Rendering
// ===========================================================================
function statusAccent(percent) {
  if (percent >= 90) return 'rose';
  if (percent >= 70) return 'amber';
  return 'emerald';
}

function applyAccentClass(card, percent) {
  card.removeAttribute('data-accent');
  card.setAttribute('data-accent', statusAccent(percent));
}

function renderConnection() {
  const cs = $('#conn-status');
  const ft = $('#footer-conn');
  cs.classList.add('online');
  $('#conn-text').textContent = 'live';
  ft.classList.add('online');
  ft.innerHTML = '<span class="indicator-dot"></span> live';
  if (state.connected || state.metrics) {
    $('#dashboard-loading').classList.add('hidden');
    $('#dashboard-content').classList.remove('hidden');
  } else {
    $('#dashboard-loading').classList.remove('hidden');
    $('#dashboard-content').classList.add('hidden');
  }
}

function renderDeviceInfo() {
  const info = state.deviceInfo;
  if (!info) return;

  // Header (hostname replaced with browser/platform)
  $('#di-hostname').textContent = `${info.browser.name} ${info.browser.version || ''}`.trim();

  // CPU
  $('#di-cpu').textContent = info.cpu.model;
  $('#di-cpu').title = info.cpu.model;
  $('#di-cores').textContent = info.cpu.coresLogical ? `${info.cpu.coresLogical} cores` : '—';
  $('#cpu-cores-footer').textContent = info.cpu.coresLogical ? `${info.cpu.coresLogical} logical cores` : 'cores unknown';

  // RAM
  $('#di-ram').textContent = info.ram.displayTotal || (info.ram.totalGb ? `${info.ram.totalGb} GB` : 'Unknown');
  $('#ram-total').textContent = info.ram.totalGb || 0;

  // Disk
  if (info.disk && !info.disk.unavailable) {
    $('#di-disk').textContent = `${info.disk.quotaGb.toFixed(1)} GB avail`;
    $('#ssd-total').textContent = info.disk.quotaGb.toFixed(1);
  } else {
    $('#di-disk').textContent = 'Unknown';
    $('#ssd-total').textContent = 0;
  }

  // GPU
  const gpuAvailEl = $('#gpu-unavailable');
  const gpuMetricsEl = $('#gpu-metrics-grid');
  const gpuChartEl = $('#gpu-chart-card');
  if (info.gpu.available) {
    $('#di-gpu').textContent = info.gpu.description || 'WebGPU GPU';
    $('#di-gpu').title = info.gpu.description || '';
    $('#di-gpu').classList.add('accent');
    $('#di-vram').textContent = info.gpu.architecture !== 'Unknown' ? info.gpu.architecture : 'WebGPU';
    $('#di-vram').classList.add('accent');
    gpuAvailEl?.classList.add('hidden');
    gpuMetricsEl?.classList.remove('hidden');
    gpuChartEl?.classList.remove('hidden');
  } else {
    $('#di-gpu').textContent = 'Not detected';
    $('#di-gpu').classList.add('muted');
    $('#di-vram').textContent = '—';
    $('#di-vram').classList.add('muted');
    gpuAvailEl?.classList.remove('hidden');
    gpuMetricsEl?.classList.add('hidden');
    gpuChartEl?.classList.add('hidden');
    $('#gpu-temp-wrap').textContent = '—';
    $('#gpu-power-wrap').textContent = '—';
  }
}

function renderMetrics() {
  if (!state.metrics) return;
  const m = state.metrics;
  $('#status-time').textContent = new Date(m.ts).toLocaleTimeString('en-US', { hour12: false });

  // CPU
  const cpuUtil = m.cpu?.utilization ?? 0;
  state.cpuUtilHistory.push(cpuUtil);
  if (state.cpuUtilHistory.length > MAX_HISTORY) state.cpuUtilHistory.shift();
  $('#cpu-util').textContent = cpuUtil.toFixed(1);
  $('#cpu-util-bar').style.width = `${cpuUtil}%`;
  const cpuCard = $('#cpu-metrics-grid .metric-card');
  if (cpuCard) applyAccentClass(cpuCard, cpuUtil);

  // GPU (conditional — real if WebGPU available, otherwise hidden)
  if (m.gpu.available) {
    // WebGPU exposes adapter info but NOT live utilization. We can show
    // "GPU detected" with vendor info but the utilization would be fake.
    // So we show static 0% util with a note in the device card.
    $('#gpu-util').textContent = '—';
    $('#gpu-util-bar').style.width = `0%`;
    $('#gpu-vram').textContent = '—';
    $('#gpu-vram-total').textContent = '—';
    const gpuMemPct = 0;
    $('#gpu-mem').textContent = '—';
    $('#gpu-mem-bar').style.width = `0%`;
    $('#gpu-temp-wrap').textContent = 'N/A';
    $('#gpu-power-wrap').textContent = 'N/A';
  }

  // RAM
  const ramTotal = m.ram.totalGb || 0;
  const ramPct = ramTotal > 0 ? (m.ram.usedGb / ramTotal) * 100 : 0;
  $('#ram-pct').textContent = ramPct.toFixed(0);
  $('#ram-used').textContent = m.ram.usedGb.toFixed(2);
  // Display total: just show the number; the HTML template adds "GB"
  $('#ram-total').textContent = ramTotal || '—';
  $('#ram-bar').style.width = `${ramPct}%`;
  const ramCard = $('#cpu-metrics-grid .metric-card[data-accent="amber"]');
  if (ramCard) applyAccentClass(ramCard, ramPct);

  // SSD (real values from navigator.storage.estimate)
  const ssdTotal = m.ssd.totalGb || 1;
  const ssdPct = ssdTotal > 0 ? (m.ssd.usedGb / ssdTotal) * 100 : 0;
  $('#ssd-pct').textContent = ssdPct.toFixed(2);
  $('#ssd-used').textContent = m.ssd.usedGb.toFixed(2);
  $('#ssd-total').textContent = m.ssd.totalGb.toFixed(1);
  $('#ssd-bar').style.width = `${ssdPct}%`;
  $('#ssd-read').textContent = m.ssd.readMbps.toFixed(0);
  $('#ssd-write').textContent = m.ssd.writeMbps.toFixed(0);
  $('#ssd-read-2').textContent = m.ssd.readMbps.toFixed(0);
  $('#ssd-write-2').textContent = m.ssd.writeMbps.toFixed(0);
  const ssdCard = $('#cpu-metrics-grid .metric-card[data-accent="rose"]');
  if (ssdCard) applyAccentClass(ssdCard, ssdPct);

  // Network
  $('#net-rx').textContent = m.net.rxMbps.toFixed(1);
  $('#net-tx').textContent = m.net.txMbps.toFixed(1);

  $('#footer-gpu').textContent = m.gpu.available ? '—' : '—';
  $('#footer-ram').textContent = ramPct.toFixed(0);
  $('#footer-ssd').textContent = ssdPct.toFixed(0);
  $('#footer-files').textContent = state.files.length;

  drawSparkline('#ram-spark', state.metricsHistory.map((x) => x.ram.totalGb ? (x.ram.usedGb / x.ram.totalGb) * 100 : 0), '#06b6d4');
  drawLineChart('#ssd-chart', state.ssdReadHistory, '#f59e0b', 1000);
}

function drawSparkline(sel, data, color) {
  const svg = $(sel);
  if (!svg) return;
  svg.innerHTML = '';
  if (data.length < 2) return;
  const W = 200, H = 40;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - ((v - min) / range) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', pts);
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', color);
  polyline.setAttribute('stroke-width', '1.5');
  polyline.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(polyline);
}

function drawLineChart(sel, data, color, maxY) {
  const svg = $(sel);
  if (!svg) return;
  svg.innerHTML = '';
  if (data.length < 2) return;
  const vb = svg.getAttribute('viewBox').split(' ').map(Number);
  const W = vb[2], H = vb[3];
  const max = Math.max(...data, 1, maxY ? maxY * 0.1 : 0);
  const range = max || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - (v / range) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polygon.setAttribute('points', `0,${H} ${pts} ${W},${H}`);
  polygon.setAttribute('fill', color);
  polygon.setAttribute('fill-opacity', '0.15');
  svg.appendChild(polygon);
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', pts);
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', color);
  polyline.setAttribute('stroke-width', '1.5');
  polyline.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(polyline);
}

function renderRunState() {
  const runBtn = $('#run-btn');
  const stopBtn = $('#stop-btn');
  const llmFile = state.files.find((f) => f.category === 'llm');
  const canRun = !!llmFile && (state.runState === 'idle' || state.runState === 'stopped' || state.runState === 'error');

  if (state.runState === 'running' || state.runState === 'loading') {
    runBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    stopBtn.querySelector('span').textContent = state.runState === 'loading' ? 'Loading…' : 'Stop';
  } else {
    runBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    runBtn.disabled = !canRun;
  }

  const dot = $('#status-dot');
  const txt = $('#status-text');
  dot.className = 'status-dot';
  if (state.runState === 'running') {
    dot.classList.add('running');
    txt.textContent = 'Model active — inference running';
  } else if (state.runState === 'loading') {
    dot.classList.add('loading');
    txt.textContent = 'Loading model into VRAM…';
  } else if (state.runState === 'error') {
    dot.classList.add('error');
    txt.textContent = 'Error occurred';
  } else if (state.runState === 'stopped') {
    txt.textContent = 'Run stopped';
  } else {
    txt.textContent = 'System idle';
  }

  const badge = $('#model-badge');
  if (state.activeModel && (state.runState === 'running' || state.runState === 'loading')) {
    badge.classList.remove('hidden');
    $('#active-model').textContent = state.activeModel;
    startUptime();
  } else {
    badge.classList.add('hidden');
    stopUptime();
  }

  $('#footer-run').textContent = state.runState;
  const pulse = $('#chat-tab-pulse');
  if (state.runState === 'running') pulse.classList.remove('hidden');
  else pulse.classList.add('hidden');

  const chatBadge = $('#chat-model-badge');
  if (state.activeModel && state.runState === 'running') {
    chatBadge.textContent = state.activeModel;
    chatBadge.classList.remove('hidden');
  } else {
    chatBadge.classList.add('hidden');
  }

  renderChatInput();
}

function startUptime() {
  if (state.uptimeTimer) return;
  if (!state.runStartedAt) return;
  const tick = () => {
    if (!state.runStartedAt) return;
    const secs = Math.floor((Date.now() - state.runStartedAt) / 1000);
    const h = String(Math.floor(secs / 3600)).padStart(2, '0');
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    $('#uptime').textContent = `${h}:${m}:${s}`;
  };
  tick();
  state.uptimeTimer = setInterval(tick, 1000);
}

function stopUptime() {
  if (state.uptimeTimer) {
    clearInterval(state.uptimeTimer);
    state.uptimeTimer = null;
  }
}

function renderFiles() {
  const list = $('#file-list');
  const summary = $('#files-summary');
  const clearBtn = $('#clear-files-btn');

  if (state.files.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
        <p class="empty-title">No files yet</p>
        <p class="empty-sub">Drag & drop to begin</p>
      </div>`;
    summary.classList.add('hidden');
    clearBtn.classList.add('hidden');
    return;
  }

  clearBtn.classList.remove('hidden');

  const groups = { llm: [], dataset: [], config: [], other: [] };
  state.files.forEach((f) => groups[f.category].push(f));

  const totalSize = state.files.reduce((a, f) => a + f.sizeBytes, 0);
  let summaryHtml = `<span class="chip">${state.files.length} files</span><span class="chip">${humanSize(totalSize)}</span>`;
  if (state.activeModel) {
    summaryHtml += `<span class="chip active-model">active: ${escapeHtml(state.activeModel)}</span>`;
  }
  summary.innerHTML = summaryHtml;
  summary.classList.remove('hidden');

  const CATEGORY_META = {
    llm: { label: 'LLM Models', icon: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/>' },
    dataset: { label: 'Datasets', icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>' },
    config: { label: 'Config Files', icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
    other: { label: 'Other Files', icon: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>' },
  };

  let html = '';
  Object.entries(groups).forEach(([cat, list]) => {
    if (list.length === 0) return;
    const meta = CATEGORY_META[cat];
    html += `<div class="file-group">
      <div class="file-group-header"><span>${meta.label}</span><span class="count">· ${list.length}</span></div>
      <div class="file-list-items">`;
    list.forEach((f) => {
      const time = new Date(f.uploadedAt).toLocaleTimeString('en-US', { hour12: false });
      html += `<div class="file-row">
        <span class="file-icon ${f.category}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${meta.icon}</svg></span>
        <div class="file-info">
          <div class="file-name">${escapeHtml(f.name)}</div>
          <div class="file-meta">${f.humanSize} · ${time}</div>
        </div>
        <button class="file-delete" data-id="${f.id}" title="Delete file">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>`;
    });
    html += `</div></div>`;
  });

  list.innerHTML = html;
  $$('.file-delete').forEach((btn) => {
    btn.addEventListener('click', () => deleteFile(btn.dataset.id));
  });
  $('#footer-files').textContent = state.files.length;
}

function renderConsole() {
  const out = $('#console-output');
  $('#console-count').textContent = `${state.consoleLines.length} lines`;
  if (state.consoleLines.length === 0) {
    out.innerHTML = '<div class="console-empty">No output yet.</div>';
    return;
  }
  const LEVEL_ICON = { info: 'ℹ', warn: '⚠', error: '✗', success: '✓' };
  let html = '';
  state.consoleLines.forEach((l) => {
    const ts = new Date(l.ts).toLocaleTimeString('en-US', { hour12: false });
    html += `<div class="console-line ${l.level}">
      <span class="ts">${ts}</span>
      <span class="level">${LEVEL_ICON[l.level] || 'ℹ'}</span>
      <span class="text">${escapeHtml(l.text)}</span>
    </div>`;
  });
  out.innerHTML = html;
  out.scrollTop = out.scrollHeight;
}

function renderChatMessages() {
  const container = $('#chat-messages');
  if (state.chatMessages.length === 0) {
    const sub = state.runState !== 'running'
      ? 'Click Run in the header to load the model first.'
      : 'Type a message and press Cmd/Ctrl+Enter to send.';
    container.innerHTML = `<div class="chat-empty"><p class="ce-sub">${sub}</p></div>`;
    return;
  }
  const USER_AVATAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  const AI_AVATAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg>';
  let html = '';
  state.chatMessages.forEach((m) => {
    const isUser = m.role === 'user';
    const avatar = isUser ? USER_AVATAR : AI_AVATAR;
    let content = escapeHtml(m.content);
    if (m.streaming && !m.content) {
      content = '<span class="chat-thinking">thinking…</span>';
    } else if (m.streaming) {
      content += '<span class="chat-cursor"></span>';
    }
    const meta = m.latencyMs ? `<div class="chat-meta">${(m.latencyMs / 1000).toFixed(2)}s</div>` : '';
    html += `<div class="chat-message ${m.role}">
      <div class="chat-avatar ${m.role}">${avatar}</div>
      <div class="chat-bubble-wrap">
        <div class="chat-bubble">${content}</div>
        ${meta}
      </div>
    </div>`;
  });
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function renderChatInput() {
  const input = $('#chat-input');
  const sendBtn = $('#chat-send-btn');
  const stopBtn = $('#chat-stop-btn');
  if (state.runState === 'running') {
    input.disabled = false;
    input.placeholder = 'Type a message… (Cmd/Ctrl+Enter to send)';
  } else {
    input.disabled = true;
    input.placeholder = 'Run model first to chat…';
  }
  if (state.chatStreaming) {
    sendBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
  } else {
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    sendBtn.disabled = state.runState !== 'running' || !input.value.trim();
  }
}

function renderBenchmark() {
  const empty = $('#benchmark-empty');
  const content = $('#benchmark-content');
  const tabPulse = $('#benchmark-tab-pulse');
  if (state.benchmarkResults.length === 0) {
    empty.classList.remove('hidden');
    content.classList.add('hidden');
    tabPulse.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  content.classList.remove('hidden');
  tabPulse.classList.remove('hidden');
  renderVerdict();
  renderDimScores();
  renderRadarChart();
  renderBarChart();
  renderTestHistory();
  renderCompareSelect();
}

function renderVerdict() {
  const v = computeVerdict();
  const testsCount = state.benchmarkResults.length;
  $('#verdict-tests-count').textContent = `${testsCount} test${testsCount === 1 ? '' : 's'}`;
  if (!v) {
    $('#verdict-main').innerHTML = '<span class="dim">No data yet.</span>';
    $('#verdict-detail').textContent = '';
    return;
  }
  const userScore = v.userOverall;
  const closest = v.closest;
  const onPar = Math.abs(closest.diff) <= 3;
  let mainHtml;
  if (onPar) {
    mainHtml = `On par with <span class="highlight">${closest.name}</span> <span class="dim">(${Math.abs(closest.diff)} pts · ${userScore} vs ${closest.overall})</span>`;
  } else if (closest.diff > 0) {
    mainHtml = `Beats <span class="highlight">${closest.name}</span> <span class="dim">(+${closest.diff} pts · ${userScore} vs ${closest.overall})</span>`;
  } else {
    mainHtml = `Slightly below <span class="highlight">${closest.name}</span> <span class="dim">(${Math.abs(closest.diff)} pts · ${userScore} vs ${closest.overall})</span>`;
  }
  $('#verdict-main').innerHTML = mainHtml;
  let detail = '';
  if (v.beats.length > 0) {
    const list = v.beats.slice(0, 3).map((b) => `<span class="pos">${b.name}</span> (+${b.diff})`).join(', ');
    detail += `Beats ${v.beats.length} LLM: ${list}${v.beats.length > 3 ? '…' : ''}. `;
  }
  if (v.losesTo.length > 0) {
    const list = v.losesTo.slice(0, 3).map((b) => `<span class="neg">${b.name}</span> (${b.diff})`).join(', ');
    detail += `Loses to ${v.losesTo.length} LLM: ${list}${v.losesTo.length > 3 ? '…' : ''}.`;
  }
  if (!detail) detail = `Your LLM is in a unique position — no exact match.`;
  $('#verdict-detail').innerHTML = detail;
}

function renderDimScores() {
  const scores = aggregateUserScores();
  const container = $('#dim-scores');
  if (!scores) { container.innerHTML = ''; return; }
  let html = '';
  DIMENSIONS.forEach((d) => {
    const v = scores[d.key];
    html += `
      <div class="dim-row">
        <div class="dim-label-row">
          <span class="dim-label">${d.label}</span>
          <span class="dim-value">${v}/100</span>
        </div>
        <div class="dim-bar-bg"><div class="dim-bar" style="width:${v}%"></div></div>
        <div class="dim-hint">${d.hint}</div>
      </div>`;
  });
  container.innerHTML = html;
}

function renderCompareSelect() {
  const sel = $('#radar-compare-select');
  if (!sel || sel.dataset.populated === '1') return;
  let opts = '';
  Object.entries(BENCHMARKS).forEach(([key, b]) => {
    opts += `<option value="${key}">${b.name}</option>`;
  });
  sel.innerHTML = opts;
  sel.value = state.radarCompareKey;
  sel.dataset.populated = '1';
}

function renderRadarChart() {
  const scores = aggregateUserScores();
  if (!scores) return;
  const cmp = BENCHMARKS[state.radarCompareKey];
  const cmpScores = llmBenchmarkToDimensions(cmp);
  $('#radar-compare-name').textContent = cmp ? cmp.name : '—';
  const svg = $('#radar-user');
  const W = 320, H = 280, cx = W / 2, cy = H / 2 + 8, R = 95;
  const n = DIMENSIONS.length;
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const r = R * i / 5;
    const pts = DIMENSIONS.map((_, j) => {
      const angle = -Math.PI / 2 + j * 2 * Math.PI / n;
      return `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`;
    }).join(' ');
    html += `<polygon points="${pts}" fill="none" stroke="${i === 5 ? '#3f3f46' : '#27272a'}" stroke-width="1"/>`;
  }
  DIMENSIONS.forEach((d, i) => {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / n;
    const x = cx + R * Math.cos(angle);
    const y = cy + R * Math.sin(angle);
    html += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#3f3f46" stroke-width="1"/>`;
    const lx = cx + (R + 22) * Math.cos(angle);
    const ly = cy + (R + 22) * Math.sin(angle);
    html += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="#a1a1aa" font-size="10" font-weight="500" text-anchor="middle" dominant-baseline="middle">${d.label}</text>`;
    const sx = cx + (R + 22) * Math.cos(angle);
    const sy = cy + (R + 22) * Math.sin(angle) + 12;
    html += `<text x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" fill="#10b981" font-size="9" font-family="JetBrains Mono, monospace" text-anchor="middle">${scores[d.key]}</text>`;
  });
  if (cmpScores) {
    const cmpPts = DIMENSIONS.map((d, i) => {
      const angle = -Math.PI / 2 + i * 2 * Math.PI / n;
      const r = R * (cmpScores[d.key] / 100);
      return `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`;
    }).join(' ');
    html += `<polygon points="${cmpPts}" fill="rgba(161,161,170,0.10)" stroke="#71717a" stroke-width="1.5" stroke-dasharray="3,2"/>`;
  }
  const userPts = DIMENSIONS.map((d, i) => {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / n;
    const r = R * (scores[d.key] / 100);
    return `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`;
  }).join(' ');
  html += `<polygon points="${userPts}" fill="rgba(16,185,129,0.30)" stroke="#10b981" stroke-width="2"/>`;
  DIMENSIONS.forEach((d, i) => {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / n;
    const r = R * (scores[d.key] / 100);
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    html += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#10b981"/>`;
  });
  svg.innerHTML = html;
}

function renderBarChart() {
  const userOverall = aggregateUserOverall();
  const svg = $('#bar-chart');
  const W = 700;
  const padding = { left: 140, right: 60, top: 10, bottom: 10 };
  const barH = 22;
  const rowH = 32;
  const chartW = W - padding.left - padding.right;
  const rows = [{ name: "Your LLM", score: userOverall, color: '#10b981', isUser: true }];
  Object.entries(BENCHMARKS).forEach(([key, b]) => {
    rows.push({ name: b.name, score: llmOverallScore(b), color: b.color, isUser: false });
  });
  rows.sort((a, b) => b.score - a.score);
  const H = padding.top + padding.bottom + rows.length * rowH;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  let html = '';
  [25, 50, 75, 100].forEach((v) => {
    const x = padding.left + chartW * v / 100;
    html += `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${H - padding.bottom}" stroke="#27272a" stroke-width="1" stroke-dasharray="2,3"/>`;
    html += `<text x="${x}" y="${H - 2}" fill="#52525b" font-size="9" text-anchor="middle">${v}</text>`;
  });
  rows.forEach((r, i) => {
    const y = padding.top + i * rowH + 4;
    html += `<text x="${padding.left - 8}" y="${y + barH / 2 + 4}" fill="${r.isUser ? '#10b981' : '#a1a1aa'}" font-size="11" font-weight="${r.isUser ? 700 : 500}" text-anchor="end">${r.name}</text>`;
    html += `<rect x="${padding.left}" y="${y}" width="${chartW}" height="${barH}" fill="#27272a" rx="2"/>`;
    const barW = chartW * r.score / 100;
    html += `<rect x="${padding.left}" y="${y}" width="${barW.toFixed(1)}" height="${barH}" fill="${r.color}" rx="2" ${r.isUser ? 'stroke="#34d399" stroke-width="1"' : ''}/>`;
    html += `<text x="${(padding.left + barW + 6).toFixed(1)}" y="${y + barH / 2 + 4}" fill="${r.color}" font-size="11" font-weight="700" font-family="JetBrains Mono, monospace">${r.score}</text>`;
  });
  svg.innerHTML = html;
}

function renderTestHistory() {
  const container = $('#test-history');
  if (state.benchmarkResults.length === 0) {
    container.innerHTML = '<div class="th-empty">No tests yet.</div>';
    return;
  }
  const sorted = [...state.benchmarkResults].reverse();
  let html = '';
  sorted.forEach((r) => {
    const time = new Date(r.ts).toLocaleTimeString('en-US', { hour12: false });
    const prompt = r.prompt.length > 60 ? r.prompt.slice(0, 60) + '…' : r.prompt;
    html += `
      <div class="th-row">
        <span class="th-time">${time}</span>
        <span class="th-prompt" title="${escapeHtml(r.prompt)}">${escapeHtml(prompt)}</span>
        <span class="th-score">${r.analysis.overall}/100</span>
      </div>`;
  });
  container.innerHTML = html;
}

// ===========================================================================
// Tab switching + drag&drop
// ===========================================================================
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}

function wireDropzone() {
  const dz = $('#dropzone');
  const input = $('#file-input');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files.length) uploadFiles(input.files);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach((evt) => {
    dz.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('drag-over'); });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dz.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('drag-over'); });
  });
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length && !dz.contains(e.target)) {
      uploadFiles(e.dataTransfer.files);
    }
  });
}

// ===========================================================================
// Init
// ===========================================================================
async function init() {
  // Detect real device specs first — this is the whole point of the app.
  // Wrap in try/catch so a detection failure (e.g. battery API rejection)
  // doesn't block the rest of the UI from rendering.
  try {
    state.deviceInfo = await detectDeviceInfo();
  } catch (e) {
    log(`Device detection error: ${e.message}`, 'error');
    // Fallback so the UI still renders with placeholders
    state.deviceInfo = {
      cpu: detectCPU(),
      ram: detectRAM(),
      disk: { unavailable: true },
      gpu: { available: false, reason: `detection failed: ${e.message}` },
      network: detectNetwork(),
      battery: { unavailable: true },
      browser: detectBrowser(),
    };
  }

  // Initial storage estimate
  if (navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      state.storageEstimate = {
        quota: est.quota,
        usage: est.usage,
        quotaGb: est.quota ? est.quota / (1024 ** 3) : 0,
        usageGb: est.usage ? est.usage / (1024 ** 3) : 0,
      };
    } catch (e) { /* ignore */ }
  }

  connectSocket();
  wireDropzone();

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#run-btn').addEventListener('click', handleRun);
  $('#stop-btn').addEventListener('click', handleStop);
  $('#clear-files-btn').addEventListener('click', clearAllFiles);
  $('#clear-console-btn').addEventListener('click', () => { state.consoleLines = []; renderConsole(); });
  $('#chat-input').addEventListener('input', renderChatInput);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); }
  });
  $('#chat-send-btn').addEventListener('click', sendMessage);
  $('#chat-stop-btn').addEventListener('click', stopChat);
  $('#clear-chat-btn').addEventListener('click', clearChat);
  $('#radar-compare-select').addEventListener('change', (e) => {
    state.radarCompareKey = e.target.value;
    renderRadarChart();
  });
  $('#clear-benchmark-btn').addEventListener('click', () => {
    state.benchmarkResults = [];
    renderBenchmark();
    log('Benchmark cleared.', 'info');
  });

  renderConnection();
  renderFiles();
  renderRunState();
  renderConsole();
  renderChatMessages();
  renderChatInput();
  renderBenchmark();
  renderDeviceInfo();
}

document.addEventListener('DOMContentLoaded', init);
