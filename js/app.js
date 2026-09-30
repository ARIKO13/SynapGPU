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
 * else null.
 *
 * On the public web version (GitHub Pages) we only use WebGPU — it's the
 * modern browser API for GPU compute, and the user explicitly asked for
 * Chrome WebGPU here. For real device hardware specs (CPU model, RAM total,
 * GPU model via WebGL UNMASKED_RENDERER), users should download the desktop
 * version which has OS-level access.
 */
async function detectGPU() {
  if (!('gpu' in navigator)) {
    return { available: false, reason: 'WebGPU API not supported in this browser. Use Chrome 113+ or Edge 113+.' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { available: false, reason: 'No compatible GPU adapter found' };
    }
    let info = null;
    try {
      info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
    } catch (e) {
      info = null;
    }
    if (!info) {
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
 *
 * On the public web version we use WebGPU for GPU info (not WebGL).
 * For real device hardware specs (CPU model name, real GPU name like
 * RTX 4060, full RAM), users should download the desktop version
 * which has OS-level access via nvidia-smi / wmic / system_profiler.
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
  state.deviceInfo = info;

  if (gpu.available) {
    log(`GPU detected: ${gpu.description}`, 'success');
  } else {
    log(`GPU: ${gpu.reason || 'not available'}`, 'warn');
    log('Tip: For real device hardware specs (CPU model, real GPU name like RTX 4060), download the desktop version.', 'info');
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
// Mock knowledge base — pre-written answers untuk topik umum.
// Penting: response harus RELEVAN dengan prompt supaya benchmark analyzer
// score-nya akurat. Kalau response nggak nyambung, score akan drop.

const MOCK_KNOWLEDGE = {
  // --- Indonesian geography & landmarks ---
  jakarta: {
    match: /jakarta/i,
    text: "Jakarta adalah ibu kota Republik Indonesia sejak kemerdekaan tahun 1945. Kota terbesar di Asia Tenggara dengan populasi sekitar 10 juta jiwa.\n\nSebagai pusat pemerintahan dan ekonomi, Jakarta menampung markas besar BUMN, bank sentral (Bank Indonesia), dan kantor kedutaan besar negara-negara asing. Kota ini juga merupakan hub transportasi utama dengan Bandara Soekarno-Hatta yang melayani jutaan penumpang per tahun.\n\nNamun, pemerintah Indonesia sedang memindahkan ibu kota ke Nusantara di Kalimantan Timur karena Jakarta menghadapi tantangan serius: banjir tahunan, penurunan tanah (land subsidence), dan kepadatan lalu lintas yang parah.",
  },
  monas: {
    match: /monas|monumen nasional/i,
    text: "Monas (Monumen Nasional) adalah ikon kota Jakarta, terletak di Lapangan Medan Merdeka. Diresmikan oleh Presiden Soekarno pada 17 Agustus 1961 dan dibuka untuk umum tahun 1975.\n\nTinggi total 132 meter, dengan puncak dilapisi emas 50 kg. Di bagian atas terdapat pelataran observasi pada ketinggian 115 meter yang bisa diakses via lift. Di dasar terdapat museum sejarah Indonesia.\n\nApi emas di puncak Monas melambangkan semangat perjuangan kemerdekaan. Setiap hari raya, Monas menjadi titik fokus upacara kenegaraan.",
  },
  indonesia: {
    match: /indonesia/i,
    text: "Indonesia adalah negara kepulauan terbesar di dunia, terdiri dari 17.508 pulau yang membentang sepanjang 5.120 km dari Sabang sampai Merauke.\n\nDengan populasi 275+ juta jiwa, Indonesia adalah negara berpenduduk ke-4 terbesar dunia setelah China, India, dan Amerika Serikat. Bahasa resmi adalah Bahasa Indonesia, namun terdapat 700+ bahasa daerah.\n\nIndonesia merdeka pada 17 Agustus 1945 setelah Soekarno-Hatta memproklamasikan kemerdekaan. Sistem pemerintahan republik presidensial, dengan ibu kota baru Nusantara (dalam proses pemindahan dari Jakarta).\n\nEkonomi terbesar di Asia Tenggara, anggota G20, dengan PDB nominal sekitar 1.3 triliun USD.",
  },
  bandung: {
    match: /bandung/i,
    text: "Bandung adalah ibu kota Provinsi Jawa Barat, terletak 768 meter di atas permukaan laut. Dijuluki 'Kota Kembang' karena keindahan taman dan bunganya.\n\nBandung dikenal sebagai pusat pendidikan tinggi (ITB, Universitas Padjadjaran, UNPAR), kuliner (seblak, batagor, surabi), dan fashion (factory outlet). Iklim sejuk (18-25°C) menjadikannya destinasi wisata favorit warga Jakarta.\n\nSejarah: Bandung pernah dijuluki 'Parijs van Java' oleh kolonial Belanda karena kemiripan iklimnya dengan Paris. Konferensi Asia-Afrika 1955 diadakan di sini, momen penting bagi gerakan Non-Blok.",
  },
  surabaya: {
    match: /surabaya/i,
    text: "Surabaya adalah ibu kota Jawa Timur dan kota terbesar kedua di Indonesia setelah Jakarta. Dijuluki 'Kota Pahlawan' karena Pertempuran Surabaya 10 November 1945.\n\nSurabaya adalah pelabuhan utama Indonesia, hub industri dan perdagangan. Jembatan Suramadu menghubungkan Surabaya dengan Pulau Madura.\n\nSimbol kota: ikan hiu dan buaya (Suro dan Boyo), melambangkan legenda pendiri kota. Monumen Kapal Selam di Taman Monumen Kapal Selam menjadi ikon wisata.",
  },
  borobudur: {
    match: /borobudur/i,
    text: "Candi Borobudur adalah candi Buddha terbesar di dunia, terletak di Magelang, Jawa Tengah. Dibangun pada abad ke-8 oleh Dinasti Syailendra.\n\nArsitektur: 6 teras persegi + 3 teras melingkar, dengan 504 arca Buddha dan 2.672 panel relief. Puncaknya adalah stupa utama yang dikelilingi 72 stupa berlubang berisi arca Buddha.\n\nUNESCO menetapkan Borobudur sebagai World Heritage Site tahun 1991. Setiap Waisak, ribuan umat Buddha berkumpul untuk meditasi.\n\nBorobudur ditinggalkan abad ke-14 seiring masuknya Islam, kemudian tertutup abu vulkanik Merapi dan vegetasi hingga ditemukan kembali oleh Sir Thomas Stamford Raffles tahun 1814.",
  },
  // --- Tech topics ---
  webgpu: {
    match: /webgpu|web ?gpu/i,
    text: "WebGPU is a modern web API that exposes GPU compute and graphics capabilities directly in the browser. Unlike WebGL, it's built on top of Vulkan/Metal/D3D12 and supports general-purpose compute shaders.\n\nKey advantages:\n- Direct GPU memory access from JavaScript\n- Compute shaders (not just graphics)\n- Lower overhead than WebGL\n\nIn SynapGPU, we use WebGPU to detect your GPU model — that's why your device info shows up in the Device card.\n\nFor LLM inference specifically, WebGPU enables in-browser execution of small models (7B-13B quantized) via projects like transformers.js and wllama.",
  },
  python: {
    match: /\bpython\b/i,
    text: "Python adalah bahasa pemrograman tingkat tinggi yang dibuat oleh Guido van Rossum tahun 1991. Dikenal karena sintaks yang clean dan readable.\n\nFilosofi Python: 'There should be one — and preferably only one — obvious way to do it' (The Zen of Python).\n\nContoh kode:\n```python\ndef fibonacci(n):\n    \"\"\"Generate Fibonacci sequence up to n.\"\"\"\n    a, b = 0, 1\n    result = []\n    while a < n:\n        result.append(a)\n        a, b = b, a + b\n    return result\n\nprint(fibonacci(100))  # [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]\n```\n\nPython dipakai di: web (Django, Flask), data science (NumPy, Pandas), AI/ML (PyTorch, TensorFlow), automation, scripting.",
  },
  ai: {
    match: /\bai\b|artificial intelligence|kecerdasan buatan/i,
    text: "AI (Artificial Intelligence) / Kecerdasan Buatan adalah bidang ilmu komputer yang fokus pada sistem yang dapat meniru kecerdasan manusia.\n\nKategori utama AI:\n1. **Narrow AI** — spesifik satu tugas (chatbot, image recognition, recommendation system). Semua AI yang ada sekarang termasuk kategori ini.\n2. **General AI (AGI)** — AI yang bisa belajar tugas apapun seperti manusia. Belum ada, masih research.\n3. **Super AI (ASI)** — melebihi kecerdasan manusia. Spekulatif.\n\nTeknik utama: Machine Learning (supervised, unsupervised, reinforcement), Deep Learning (neural network berlapis), NLP (language), Computer Vision (image), dan sekarang LLM (Large Language Model) seperti GPT, Claude, Llama.\n\nEtika AI: bias, privasi, displacement pekerjaan, dan keamanan menjadi perdebatan aktif.",
  },
  llm: {
    match: /\bllm\b|large language model/i,
    text: "LLM (Large Language Model) adalah model AI yang dilatih pada miliaran token teks untuk memahami dan menghasilkan bahasa manusia.\n\nArsitektur: Transformer (diperkenalkan Google 2017 dengan paper 'Attention Is All You Need'). Parameter: 7B (Llama 3.1 8B), 70B (Llama 3.1 70B), 175B (GPT-3), 1T+ (GPT-4 estimation).\n\nTraining pipeline:\n1. **Pre-training** — belajar dari teks internet (Common Crawl, Wikipedia, books)\n2. **Fine-tuning** — instruction tuning (chat, Q&A)\n3. **RLHF** — Reinforcement Learning from Human Feedback\n\nBenchmark utama: MMLU (knowledge), HumanEval (code), GSM8K (math), LMSYS Arena (human preference).\n\nSynapGPU membandingkan model kamu dengan 14 LLM publik di tab Benchmark.",
  },
};

const MOCK_RESPONSES_FALLBACK = {
  quicksort: {
    match: /quicksort|sort algorithm/i,
    text: "Here's a clean Python quicksort implementation:\n\n```python\ndef quicksort(arr):\n    \"\"\"Sort a list in-place using quicksort.\n\n    Time: O(n log n) average, O(n²) worst case.\n    Space: O(n) for list comprehensions.\n    \"\"\"\n    if len(arr) <= 1:\n        return arr\n    pivot = arr[len(arr) // 2]\n    left = [x for x in arr if x < pivot]\n    middle = [x for x in arr if x == pivot]\n    right = [x for x in arr if x > pivot]\n    return quicksort(left) + middle + quicksort(right)\n\nprint(quicksort([3, 6, 8, 10, 1, 2, 1]))  # [1, 1, 2, 3, 6, 8, 10]\n```\n\nIn-place version (O(1) extra space, O(log n) call stack):\n```python\ndef quicksort_inplace(arr, low=0, high=None):\n    if high is None: high = len(arr) - 1\n    if low < high:\n        pivot_idx = partition(arr, low, high)\n        quicksort_inplace(arr, low, pivot_idx - 1)\n        quicksort_inplace(arr, pivot_idx + 1, high)\n```",
  },
  integral: {
    match: /integral|x\^2|math|calculate|integral dari/i,
    text: "Untuk menghitung ∫₀³ x² dx:\n\n**Langkah 1: Antiturunan**\nAntiturunan dari xⁿ adalah xⁿ⁺¹/(n+1).\nUntuk x², n=2, sehingga antiturunan = x³/3.\n\n**Langkah 2: Substitusi batas**\n∫₀³ x² dx = [x³/3]₀³\n         = (3³/3) - (0³/3)\n         = 27/3 - 0\n         = **9**\n\nJadi nilai integralnya adalah 9.\n\nSecara geometris, ini adalah luas daerah di bawah kurva y = x² dari x=0 sampai x=3, yang membentuk area melengkung dengan luas 9 satuan persegi.\n\nVerifikasi dengan aturan trapesium atau Simpson akan mendekati nilai 9 untuk partisi yang cukup halus.",
  },
  startup: {
    match: /startup|idea|name|ide nama/i,
    text: "Berikut 5 ide nama startup AI:\n\n1. **SynapStack** — platform infrastruktur neural network\n2. **TokenForge** — service fine-tuning API\n3. **GPUHive** — marketplace distributed inference\n4. **QuantaLabs** — konsultansi riset AI terapan\n5. **Vexa AI** — platform asisten voice-first\n\nTiap nama pendek, brandable, .com-friendly, dan menggambarkan metafora neural/synaptic atau komputasi/quantum.",
  },
};

function pickMockResponse(prompt) {
  // Coba knowledge base dulu (Indonesia topics, tech, etc)
  for (const key in MOCK_KNOWLEDGE) {
    if (MOCK_KNOWLEDGE[key].match.test(prompt)) {
      return MOCK_KNOWLEDGE[key].text;
    }
  }
  // Fallback patterns (code, math, startup)
  for (const key in MOCK_RESPONSES_FALLBACK) {
    if (MOCK_RESPONSES_FALLBACK[key].match.test(prompt)) {
      return MOCK_RESPONSES_FALLBACK[key].text;
    }
  }
  // Generic fallback — coba jawab dengan struktur yang reasonable
  return `Pertanyaanmu tentang "${prompt}" menarik. Namun ini adalah demo web publik SynapGPU yang berjalan di GitHub Pages — tidak bisa memanggil LLM API sungguhan karena masalah keamanan (API key tidak boleh di-expose di browser).\n\nUntuk jawaban LLM yang sebenarnya:\n1. Download versi Desktop dari tombol di header\n2. Install Ollama di komputermu\n3. Jalankan SynapGPU Desktop — otomatis detect Ollama\n4. Chat dengan LLM sungguhan (Llama 3.1, Mistral, dll)\n\nDemo web ini cocok untuk: preview UI, cek spek device, dan lihat format benchmark report. Untuk inference LLM sungguhan, pakai versi Desktop.`;
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
// Benchmark — same analyzer as the real app.
// ===========================================================================
// Public benchmarks of real-world LLMs. Scores are normalized to 0-100.
// Sources (mid-2024 numbers, can be refreshed from):
//   - Open LLM Leaderboard: https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard
//   - LMSYS Chatbot Arena:  https://chat.lmsys.org/?leaderboard
//   - Artificial Analysis:   https://artificialanalysis.ai/
//
// For the desktop version, these get fetched live via httpx so they stay
// current with the latest leaderboard updates.
const BENCHMARKS = {
  gpt4o:         { name: "GPT-4o",               color: "#10a37f", mmlu: 88.7, humaneval: 90.2, gsm8k: 95.8, math: 76.6, reasoning: 93, speed_tps: 80,  source: "openai.com" },
  gpt4_turbo:    { name: "GPT-4 Turbo",          color: "#10a37f", mmlu: 86.5, humaneval: 85.4, gsm8k: 92.0, math: 52.5, reasoning: 90, speed_tps: 50,  source: "openai.com" },
  claude35:      { name: "Claude 3.5 Sonnet",    color: "#d97706", mmlu: 88.7, humaneval: 92.0, gsm8k: 96.4, math: 71.1, reasoning: 95, speed_tps: 80,  source: "anthropic.com" },
  claude3_opus:  { name: "Claude 3 Opus",        color: "#d97706", mmlu: 86.8, humaneval: 84.9, gsm8k: 95.0, math: 60.1, reasoning: 92, speed_tps: 30,  source: "anthropic.com" },
  gemini15_pro:  { name: "Gemini 1.5 Pro",       color: "#4285f4", mmlu: 85.9, humaneval: 84.1, gsm8k: 91.7, math: 67.7, reasoning: 91, speed_tps: 50,  source: "deepmind.google" },
  gemini_flash:  { name: "Gemini 1.5 Flash",     color: "#4285f4", mmlu: 78.9, humaneval: 71.5, gsm8k: 80.5, math: 53.0, reasoning: 84, speed_tps: 200, source: "deepmind.google" },
  llama3_405b:   { name: "Llama 3.1 405B",       color: "#0866ff", mmlu: 87.3, humaneval: 89.0, gsm8k: 96.8, math: 73.8, reasoning: 91, speed_tps: 20,  source: "ai.meta.com" },
  llama3_70b:    { name: "Llama 3.1 70B",         color: "#0866ff", mmlu: 82.0, humaneval: 80.0, gsm8k: 84.5, math: 50.0, reasoning: 85, speed_tps: 100, source: "ai.meta.com" },
  llama3_8b:     { name: "Llama 3.1 8B",          color: "#7c3aed", mmlu: 66.0, humaneval: 72.0, gsm8k: 84.0, math: 30.0, reasoning: 65, speed_tps: 150, source: "ai.meta.com" },
  mistral_large: { name: "Mistral Large 2",      color: "#ff6b35", mmlu: 84.0, humaneval: 81.0, gsm8k: 81.0, math: 45.0, reasoning: 82, speed_tps: 60,  source: "mistral.ai" },
  qwen2_72b:     { name: "Qwen2.5 72B",          color: "#06b6d4", mmlu: 84.0, humaneval: 86.0, gsm8k: 89.0, math: 50.0, reasoning: 84, speed_tps: 90,  source: "qwenlm.ai" },
  qwen2_7b:      { name: "Qwen2.5 7B",            color: "#06b6d4", mmlu: 72.0, humaneval: 75.0, gsm8k: 85.0, math: 35.0, reasoning: 70, speed_tps: 130, source: "qwenlm.ai" },
  phi3_medium:   { name: "Phi-3 Medium",          color: "#ec4899", mmlu: 78.0, humaneval: 62.0, gsm8k: 91.0, math: 45.0, reasoning: 75, speed_tps: 120, source: "microsoft.com" },
  deepseek_v2:   { name: "DeepSeek-V2",           color: "#4f46e5", mmlu: 78.5, humaneval: 81.1, gsm8k: 92.2, math: 53.7, reasoning: 80, speed_tps: 60,  source: "deepseek.com" },
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

  // GPU (WebGPU only on web version; for real hardware GPU use desktop app)
  const gpuAvailEl = $('#gpu-unavailable');
  const gpuMetricsEl = $('#gpu-metrics-grid');
  const gpuChartEl = $('#gpu-chart-card');
  if (info.gpu.available) {
    $('#di-gpu').textContent = info.gpu.description || 'WebGPU GPU';
    $('#di-gpu').title = info.gpu.description || '';
    $('#di-gpu').classList.add('accent');
    $('#di-gpu').classList.remove('muted');
    let vramText = (info.gpu.architecture && info.gpu.architecture !== 'Unknown')
      ? info.gpu.architecture
      : (info.gpu.vendor !== 'Unknown' ? info.gpu.vendor : 'WebGPU');
    $('#di-vram').textContent = vramText;
    $('#di-vram').classList.add('accent');
    $('#di-vram').classList.remove('muted');
    gpuAvailEl?.classList.add('hidden');
    gpuMetricsEl?.classList.remove('hidden');
    gpuChartEl?.classList.remove('hidden');
  } else {
    $('#di-gpu').textContent = 'Not detected';
    $('#di-gpu').classList.add('muted');
    $('#di-gpu').classList.remove('accent');
    $('#di-vram').textContent = '—';
    $('#di-vram').classList.add('muted');
    $('#di-vram').classList.remove('accent');
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
    $('#verdict-report').innerHTML = '';
    return;
  }

  const userScore = v.userOverall;
  const closest = v.closest;
  const onPar = Math.abs(closest.diff) <= 3;

  // --- Summary line (singkat, untuk at-a-glance)
  let mainHtml;
  if (onPar) {
    mainHtml = `Setara dengan <span class="highlight">${closest.name}</span> <span class="dim">(selisih ${Math.abs(closest.diff)} poin · ${userScore} vs ${closest.overall})</span>`;
  } else if (closest.diff > 0) {
    mainHtml = `Mengalahkan <span class="highlight">${closest.name}</span> <span class="dim">(+${closest.diff} poin · ${userScore} vs ${closest.overall})</span>`;
  } else {
    mainHtml = `Kalah tipis dari <span class="highlight">${closest.name}</span> <span class="dim">(${Math.abs(closest.diff)} poin · ${userScore} vs ${closest.overall})</span>`;
  }
  $('#verdict-main').innerHTML = mainHtml;
  $('#verdict-detail').textContent = `Skor kamu: ${userScore}/100 dari ${testsCount} test. Dibandingkan dengan ${v.comparisons.length} LLM publik.`;

  // --- Full report: 3 section terstruktur
  // 1. Setara (selisih ≤3 poin, excluding the closest yang udah di main)
  // 2. Mengalahkan (user's score > LLM score)
  // 3. Kalah dari (user's score < LLM score)
  const onParList = v.comparisons.filter((c) => c.key !== closest.key && Math.abs(c.diff) <= 3);
  const beats = v.beats.filter((c) => c.key !== closest.key);
  const losesTo = v.losesTo.filter((c) => c.key !== closest.key);

  let reportHtml = '';

  // Section 1: Setara
  reportHtml += `<div class="report-section">`;
  reportHtml += `<div class="report-section-header">
    <span class="report-section-title neutral">Setara dengan</span>
    <span class="report-section-count">${onParList.length} LLM</span>
  </div>`;
  if (onParList.length === 0) {
    reportHtml += `<div class="report-empty">Tidak ada LLM yang setara (selisih ≤3 poin).</div>`;
  } else {
    reportHtml += `<div class="report-list">`;
    onParList.forEach((c) => {
      const sign = c.diff > 0 ? '+' : '';
      reportHtml += `
        <div class="report-row neutral">
          <span class="report-name">${escapeHtml(c.name)}</span>
          <span class="report-score">${c.overall}/100</span>
          <span class="report-diff neutral">${sign}${c.diff}</span>
        </div>`;
    });
    reportHtml += `</div>`;
  }
  reportHtml += `</div>`;

  // Section 2: Mengalahkan
  reportHtml += `<div class="report-section">`;
  reportHtml += `<div class="report-section-header">
    <span class="report-section-title pos">Mengalahkan</span>
    <span class="report-section-count">${beats.length} LLM</span>
  </div>`;
  if (beats.length === 0) {
    reportHtml += `<div class="report-empty">Belum mengalahkan LLM publik manapun.</div>`;
  } else {
    reportHtml += `<div class="report-list">`;
    beats.forEach((c) => {
      reportHtml += `
        <div class="report-row pos">
          <span class="report-name">${escapeHtml(c.name)}</span>
          <span class="report-score">${c.overall}/100</span>
          <span class="report-diff pos">+${c.diff}</span>
        </div>`;
    });
    reportHtml += `</div>`;
  }
  reportHtml += `</div>`;

  // Section 3: Kalah dari
  reportHtml += `<div class="report-section">`;
  reportHtml += `<div class="report-section-header">
    <span class="report-section-title neg">Kalah dari</span>
    <span class="report-section-count">${losesTo.length} LLM</span>
  </div>`;
  if (losesTo.length === 0) {
    reportHtml += `<div class="report-empty">Tidak ada LLM yang lebih kuat — kamu juara!</div>`;
  } else {
    reportHtml += `<div class="report-list">`;
    losesTo.forEach((c) => {
      reportHtml += `
        <div class="report-row neg">
          <span class="report-name">${escapeHtml(c.name)}</span>
          <span class="report-score">${c.overall}/100</span>
          <span class="report-diff neg">${c.diff}</span>
        </div>`;
    });
    reportHtml += `</div>`;
  }
  reportHtml += `</div>`;

  // Source note — gh-pages uses static benchmark data
  reportHtml += `<div class="report-source">Source: HuggingFace Open LLM Leaderboard, LMSYS Chatbot Arena, official model cards (mid-2024 snapshot)</div>`;

  $('#verdict-report').innerHTML = reportHtml;
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
