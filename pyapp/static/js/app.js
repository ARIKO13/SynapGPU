/* SynapGPU — vanilla JavaScript, no framework */

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  files: [],
  runState: 'idle',
  activeModel: null,
  runStartedAt: null,
  metrics: null,
  metricsHistory: [],   // last 60 metrics for sparkline
  gpuUtilHistory: [],   // for the 60s chart
  ssdReadHistory: [],
  connected: false,
  consoleLines: [],
  chatMessages: [],
  chatStreaming: false,
  chatAbortController: null,
  uptimeTimer: null,
  benchmarkResults: [],   // array of {id, prompt, response, analysis, ts}
  radarCompareKey: 'gpt4',  // which benchmark LLM to overlay on radar
  deviceInfo: null,         // real specs detected at server startup
  cpuUtilHistory: [],       // for CPU chart
  cpuUtil: 0,               // last known CPU util
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

// ---------------------------------------------------------------------------
// Socket.IO connection
// ---------------------------------------------------------------------------
let socket = null;

function connectSocket() {
  socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1200,
    timeout: 10000,
  });

  socket.on('connect', () => {
    state.connected = true;
    log('Telemetry connected.', 'success');
    renderConnection();
  });

  socket.on('disconnect', () => {
    state.connected = false;
    log('Telemetry disconnected.', 'warn');
    renderConnection();
  });

  socket.on('metrics', (m) => {
    state.metrics = m;
    state.metricsHistory.push(m);
    if (state.metricsHistory.length > MAX_HISTORY) state.metricsHistory.shift();
    state.gpuUtilHistory.push(m.gpu.utilization);
    if (state.gpuUtilHistory.length > MAX_HISTORY) state.gpuUtilHistory.shift();
    state.ssdReadHistory.push(m.ssd.readMbps);
    if (state.ssdReadHistory.length > MAX_HISTORY) state.ssdReadHistory.shift();
    renderMetrics();
  });

  socket.on('session:state', (s) => {
    state.runState = s.runState;
    state.activeModel = s.activeModel;
    state.runStartedAt = s.runStartedAt;
    if (s.runState === 'loading') log('Loading model…', 'info');
    else if (s.runState === 'running') log('Model ready.', 'success');
    else if (s.runState === 'stopped') log('Stopped.', 'warn');
    else if (s.runState === 'idle') log('Idle.', 'info');
    renderRunState();
  });
}

// ---------------------------------------------------------------------------
// File management
// ---------------------------------------------------------------------------
async function uploadFiles(fileList) {
  const files = Array.from(fileList);
  if (files.length === 0) return;
  $('#dropzone').classList.add('uploading');
  log(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`, 'info');
  try {
    const formData = new FormData();
    files.forEach((f) => formData.append('files', f));
    const res = await fetch('/api/files', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.files = data.files;
    const totalBytes = data.created.reduce((a, f) => a + f.sizeBytes, 0);
    log(`Uploaded ${data.created.length} file${data.created.length > 1 ? 's' : ''} (${humanSize(totalBytes)}).`, 'success');
    renderFiles();
    renderRunState();
  } catch (e) {
    log(`Upload failed: ${e.message}`, 'error');
  } finally {
    $('#dropzone').classList.remove('uploading');
  }
}

async function deleteFile(id) {
  try {
    const res = await fetch(`/api/files?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.files = state.files.filter((f) => f.id !== id);
    log(`File deleted.`, 'info');
    renderFiles();
    renderRunState();
  } catch (e) {
    log(`Delete failed: ${e.message}`, 'error');
  }
}

async function clearAllFiles() {
  for (const f of state.files) {
    try {
      await fetch(`/api/files?id=${encodeURIComponent(f.id)}`, { method: 'DELETE' });
    } catch (e) { /* ignore */ }
  }
  state.files = [];
  log('All files cleared.', 'info');
  renderFiles();
  renderRunState();
}

async function refreshFiles() {
  try {
    const res = await fetch('/api/files');
    if (res.ok) {
      const data = await res.json();
      state.files = data.files;
      renderFiles();
      renderRunState();
    }
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------------
async function handleRun() {
  const llmFile = state.files.find((f) => f.category === 'llm');
  const model = llmFile ? llmFile.name : null;
  log(`Run: ${model ?? '(no model)'}`, 'info');
  try {
    await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', model }),
    });
  } catch (e) { /* non-fatal — WS is source of truth */ }
  state.runState = 'loading';
  state.activeModel = model;
  state.runStartedAt = Date.now();
  renderRunState();
}

async function handleStop() {
  log('Stop.', 'warn');
  try {
    await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    });
  } catch (e) { /* ignore */ }
  state.runState = 'stopped';
  renderRunState();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a helpful AI assistant loaded from the user's uploaded model file. Answer clearly and concisely. Demonstrate capability across reasoning, code, and instruction-following.`;

async function sendMessage() {
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

  const controller = new AbortController();
  state.chatAbortController = controller;

  try {
    const history = state.chatMessages
      .filter((m) => m.id !== assistantId && m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'token') {
            const msg = state.chatMessages.find((m) => m.id === assistantId);
            if (msg) msg.content += evt.content;
            renderChatMessages();
          } else if (evt.type === 'done') {
            const msg = state.chatMessages.find((m) => m.id === assistantId);
            if (msg) { msg.streaming = false; msg.latencyMs = evt.latencyMs; }
            // --- Analyze the response and store for benchmark ---
            const userText = userMsg.content;
            const assistantText = msg ? msg.content : '';
            if (assistantText) {
              const analysis = analyzeResponse(userText, assistantText, evt.latencyMs);
              state.benchmarkResults.push({
                id: uid(),
                prompt: userText,
                response: assistantText,
                analysis,
                ts: Date.now(),
              });
              if (state.benchmarkResults.length > MAX_BENCHMARK) {
                state.benchmarkResults = state.benchmarkResults.slice(-MAX_BENCHMARK);
              }
              renderBenchmark();
              log(`Scored ${analysis.overall}/100`, 'info');
            }
          } else if (evt.type === 'error') {
            $('#chat-error').textContent = evt.message;
            $('#chat-error').classList.remove('hidden');
            const msg = state.chatMessages.find((m) => m.id === assistantId);
            if (msg) msg.streaming = false;
          }
        } catch { /* skip */ }
      }
    }
    log('Response complete.', 'success');
    renderChatMessages();
  } catch (e) {
    if (e.name === 'AbortError') {
      log('Chat aborted.', 'warn');
    } else {
      $('#chat-error').textContent = e.message;
      $('#chat-error').classList.remove('hidden');
      log(`Chat error: ${e.message}`, 'error');
    }
    const msg = state.chatMessages.find((m) => m.id === assistantId);
    if (msg) msg.streaming = false;
    renderChatMessages();
  } finally {
    state.chatStreaming = false;
    state.chatAbortController = null;
    renderChatInput();
  }
}

function stopChat() {
  if (state.chatAbortController) state.chatAbortController.abort();
}

function clearChat() {
  state.chatMessages = [];
  renderChatMessages();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
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
  if (state.connected) {
    cs.classList.add('online');
    $('#conn-text').textContent = 'connected';
    ft.classList.add('online');
    ft.innerHTML = '<span class="indicator-dot"></span> live';
  } else {
    cs.classList.remove('online');
    $('#conn-text').textContent = 'offline';
    ft.classList.remove('online');
    ft.innerHTML = '<span class="indicator-dot"></span> offline';
  }
  // Dashboard visibility — show once we have either a metrics payload OR
  // a confirmed WebSocket connection (so the user immediately sees the
  // dashboard skeleton while the first metrics frame streams in).
  if (state.connected || state.metrics) {
    $('#dashboard-loading').classList.add('hidden');
    $('#dashboard-content').classList.remove('hidden');
  } else {
    $('#dashboard-loading').classList.remove('hidden');
    $('#dashboard-content').classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Device info — fetch real specs once on load and render the Device card.
// Also toggles between "GPU metrics grid" and "No GPU detected" warning.
// ---------------------------------------------------------------------------
async function fetchDeviceInfo() {
  try {
    const res = await fetch('/api/device-info');
    if (!res.ok) return;
    state.deviceInfo = await res.json();
    renderDeviceInfo();
  } catch (e) { /* server unavailable; skip */ }
}

function renderDeviceInfo() {
  const info = state.deviceInfo;
  if (!info) return;

  // Hostname (best-effort — backend doesn't expose this; show CPU model truncated)
  const hostname = info.cpu.model.split(/\s+/).slice(0, 4).join(' ');
  $('#di-hostname').textContent = hostname;

  // CPU
  $('#di-cpu').textContent = info.cpu.model;
  $('#di-cpu').title = info.cpu.model;
  $('#di-cores').textContent = `${info.cpu.coresPhysical}P / ${info.cpu.coresLogical}L`;
  $('#cpu-cores-footer').textContent = `${info.cpu.coresLogical} logical cores`;

  // RAM & Disk
  $('#di-ram').textContent = `${info.ram.totalGb} GB`;
  $('#ram-total').textContent = info.ram.totalGb;
  $('#di-disk').textContent = `${info.disk.totalGb} GB`;
  $('#ssd-total').textContent = info.disk.totalGb;

  // GPU
  const gpuAvailEl = $('#gpu-unavailable');
  const gpuMetricsEl = $('#gpu-metrics-grid');
  const gpuChartEl = $('#gpu-chart-card');
  const gpuTempWrap = $('#gpu-temp-wrap');
  const gpuPowerWrap = $('#gpu-power-wrap');

  if (info.gpu.available) {
    $('#di-gpu').textContent = info.gpu.name;
    $('#di-gpu').title = info.gpu.name;
    $('#di-gpu').classList.add('accent');
    $('#di-vram').textContent = `${info.gpu.vramTotalGb} GB`;
    $('#di-vram').classList.add('accent');
    $('#gpu-vram-total').textContent = info.gpu.vramTotalGb;
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
    if (gpuTempWrap) gpuTempWrap.textContent = '—';
    if (gpuPowerWrap) gpuPowerWrap.textContent = '—';
  }
}

function renderMetrics() {
  if (!state.metrics) return;
  const m = state.metrics;
  $('#status-time').textContent = new Date(m.ts).toLocaleTimeString('id-ID', { hour12: false });

  const gpuAvailable = !!m.gpu.available;

  // CPU (always available)
  const cpuUtil = m.cpu?.utilization ?? 0;
  state.cpuUtil = cpuUtil;
  state.cpuUtilHistory.push(cpuUtil);
  if (state.cpuUtilHistory.length > MAX_HISTORY) state.cpuUtilHistory.shift();
  const cpuUtilEl = $('#cpu-util');
  const cpuUtilBar = $('#cpu-util-bar');
  if (cpuUtilEl) cpuUtilEl.textContent = cpuUtil.toFixed(1);
  if (cpuUtilBar) cpuUtilBar.style.width = `${cpuUtil}%`;
  const cpuCard = $('#cpu-metrics-grid .metric-card');
  if (cpuCard) applyAccentClass(cpuCard, cpuUtil);

  // GPU (conditional)
  if (gpuAvailable && m.gpu.utilization !== undefined) {
    const gpuUtil = m.gpu.utilization;
    $('#gpu-util').textContent = gpuUtil.toFixed(1);
    $('#gpu-util-bar').style.width = `${gpuUtil}%`;
    $('#gpu-vram').textContent = m.gpu.memoryUsedGb.toFixed(1);
    $('#gpu-vram-total').textContent = m.gpu.memoryTotalGb.toFixed(0);
    const gpuMemPct = (m.gpu.memoryUsedGb / m.gpu.memoryTotalGb) * 100;
    $('#gpu-mem').textContent = gpuMemPct.toFixed(1);
    $('#gpu-mem-bar').style.width = `${gpuMemPct}%`;
    // GPU temp/power
    const tempWrap = $('#gpu-temp-wrap');
    const powerWrap = $('#gpu-power-wrap');
    if (tempWrap) tempWrap.textContent = `${m.gpu.tempC.toFixed(0)}°C`;
    if (powerWrap) powerWrap.textContent = `${m.gpu.powerW.toFixed(0)} W`;
    // Push GPU util to its history + draw chart
    state.gpuUtilHistory.push(gpuUtil);
    if (state.gpuUtilHistory.length > MAX_HISTORY) state.gpuUtilHistory.shift();
    drawSparkline('#gpu-mem-spark', state.metricsHistory.map((x) => (x.gpu.memoryUsedGb / x.gpu.memoryTotalGb) * 100), '#10b981');
    const gpuCards = $$('#gpu-metrics-grid .metric-card');
    if (gpuCards[0]) applyAccentClass(gpuCards[0], gpuUtil);
    if (gpuCards[1]) applyAccentClass(gpuCards[1], gpuMemPct);
    // GPU chart
    const avg = state.gpuUtilHistory.length
      ? state.gpuUtilHistory.reduce((a, b) => a + b, 0) / state.gpuUtilHistory.length
      : 0;
    $('#gpu-avg').textContent = avg.toFixed(1);
    drawLineChart('#gpu-chart', state.gpuUtilHistory, '#10b981', 100);
  }

  // RAM
  const ramPct = (m.ram.usedGb / m.ram.totalGb) * 100;
  $('#ram-pct').textContent = ramPct.toFixed(0);
  $('#ram-used').textContent = m.ram.usedGb.toFixed(1);
  $('#ram-total').textContent = m.ram.totalGb;
  $('#ram-bar').style.width = `${ramPct}%`;
  // Apply accent to RAM card (in cpu-metrics-grid)
  const ramCard = $('#cpu-metrics-grid .metric-card[data-accent="amber"]');
  if (ramCard) applyAccentClass(ramCard, ramPct);

  // SSD
  const ssdPct = (m.ssd.usedGb / m.ssd.totalGb) * 100;
  $('#ssd-pct').textContent = ssdPct.toFixed(1);
  $('#ssd-used').textContent = m.ssd.usedGb.toFixed(0);
  $('#ssd-total').textContent = m.ssd.totalGb;
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

  // Footer summary
  $('#footer-gpu').textContent = gpuAvailable ? (m.gpu.utilization ?? 0).toFixed(0) : '—';
  $('#footer-ram').textContent = ramPct.toFixed(0);
  $('#footer-ssd').textContent = ssdPct.toFixed(0);
  $('#footer-files').textContent = state.files.length;

  // RAM sparkline (always)
  drawSparkline('#ram-spark', state.metricsHistory.map((x) => (x.ram.usedGb / x.ram.totalGb) * 100), '#06b6d4');
  // SSD chart (always — replaced the GPU-only chart when no GPU)
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
  const min = 0;
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - ((v - min) / range) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  // Fill area under the line
  const lastX = W;
  const firstX = 0;
  const baseY = H;
  const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polygon.setAttribute('points', `${firstX},${baseY} ${pts} ${lastX},${baseY}`);
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

  // Status bar
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

  // Model badge
  const badge = $('#model-badge');
  if (state.activeModel && (state.runState === 'running' || state.runState === 'loading')) {
    badge.classList.remove('hidden');
    $('#active-model').textContent = state.activeModel;
    startUptime();
  } else {
    badge.classList.add('hidden');
    stopUptime();
  }

  // Footer run state
  $('#footer-run').textContent = state.runState;
  // Chat tab pulse
  const pulse = $('#chat-tab-pulse');
  if (state.runState === 'running') pulse.classList.remove('hidden');
  else pulse.classList.add('hidden');

  // Chat model badge
  const chatBadge = $('#chat-model-badge');
  if (state.activeModel && state.runState === 'running') {
    chatBadge.textContent = state.activeModel;
    chatBadge.classList.remove('hidden');
  } else {
    chatBadge.classList.add('hidden');
  }

  // Chat input enable/disable
  renderChatInput();

  // Empty-state sub text
  const ceSub = $('#ce-sub');
  if (ceSub) {
    ceSub.textContent = state.runState !== 'running'
      ? 'Click Run in the header to load the model first. Once status becomes "running", chat is active.'
      : 'Type a message and press Cmd/Ctrl+Enter or click send. Response streams token-by-token.';
  }
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
      const time = new Date(f.uploadedAt).toLocaleTimeString('id-ID', { hour12: false });
      html += `<div class="file-row">
        <span class="file-icon ${f.category}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${meta.icon}</svg></span>
        <div class="file-info">
          <div class="file-name">${escapeHtml(f.name)}</div>
          <div class="file-meta">${f.humanSize} · ${time}</div>
        </div>
        <button class="file-delete" data-id="${f.id}" title="Hapus file">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>`;
    });
    html += `</div></div>`;
  });

  list.innerHTML = html;

  // Attach delete handlers
  $$('.file-delete').forEach((btn) => {
    btn.addEventListener('click', () => deleteFile(btn.dataset.id));
  });

  $('#footer-files').textContent = state.files.length;
}

function renderConsole() {
  const out = $('#console-output');
  $('#console-count').textContent = `${state.consoleLines.length} lines`;
  if (state.consoleLines.length === 0) {
    out.innerHTML = '<div class="console-empty">No output yet. Drop a file and click Run.</div>';
    return;
  }
  const LEVEL_ICON = { info: 'ℹ', warn: '⚠', error: '✗', success: '✓' };
  let html = '';
  state.consoleLines.forEach((l) => {
    const ts = new Date(l.ts).toLocaleTimeString('id-ID', { hour12: false });
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
      content = '<span class="chat-thinking">memikirkan…</span>';
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

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}

// ---------------------------------------------------------------------------
// Benchmark — analyze chat response & compare to real LLMs
// ---------------------------------------------------------------------------
// Public benchmarks of real-world LLMs (mid-2024 numbers from official papers
// and HuggingFace leaderboards). Dimensions are normalized to 0-100.
const BENCHMARKS = {
  gpt4:          { name: "GPT-4",              color: "#10a37f", mmlu: 86.4, humaneval: 67.0, gsm8k: 92.0, math: 42.5, reasoning: 90, speed_tps: 30 },
  claude35:      { name: "Claude 3.5 Sonnet",  color: "#d97706", mmlu: 88.7, humaneval: 92.0, gsm8k: 96.4, math: 71.1, reasoning: 92, speed_tps: 80 },
  llama3_70b:    { name: "Llama 3.1 70B",       color: "#0866ff", mmlu: 82.0, humaneval: 80.0, gsm8k: 84.5, math: 50.0, reasoning: 85, speed_tps: 100 },
  mistral_large: { name: "Mistral Large 2",     color: "#ff6b35", mmlu: 84.0, humaneval: 81.0, gsm8k: 81.0, math: 45.0, reasoning: 82, speed_tps: 60 },
  llama3_8b:     { name: "Llama 3.1 8B",        color: "#7c3aed", mmlu: 66.0, humaneval: 72.0, gsm8k: 84.0, math: 30.0, reasoning: 65, speed_tps: 150 },
  gemini15:      { name: "Gemini 1.5 Pro",      color: "#4285f4", mmlu: 85.0, humaneval: 84.0, gsm8k: 91.0, math: 67.0, reasoning: 88, speed_tps: 50 },
  qwen2_72b:     { name: "Qwen2 72B",           color: "#06b6d4", mmlu: 84.0, humaneval: 86.0, gsm8k: 89.0, math: 50.0, reasoning: 84, speed_tps: 90 },
  phi3_medium:   { name: "Phi-3 Medium",        color: "#ec4899", mmlu: 78.0, humaneval: 62.0, gsm8k: 91.0, math: 45.0, reasoning: 75, speed_tps: 120 },
};

const DIMENSIONS = [
  { key: 'reasoning',  label: 'Reasoning',  hint: 'Kemampuan berpikir logis & multi-langkah' },
  { key: 'code',       label: 'Code',       hint: 'Penulisan & kelengkapan kode' },
  { key: 'math',       label: 'Math',       hint: 'Penanganan angka & formula' },
  { key: 'knowledge', label: 'Knowledge',   hint: 'Kedalaman & kekayaan konten' },
  { key: 'speed',      label: 'Speed',      hint: 'Throughput token/detik' },
  { key: 'coherence',  label: 'Coherence',  hint: 'Koherensi struktur kalimat' },
];

/**
 * Analyze a single chat response. Produces raw metrics + 6-dimension scores 0-100.
 * This is a heuristic analyzer — not a substitute for proper benchmarks like
 * MMLU, but it gives a quick, explainable signal of where the model shines
 * or struggles based on observable response characteristics.
 */
function analyzeResponse(userMsg, assistantMsg, latencyMs) {
  const promptLen = userMsg.length;
  const responseLen = assistantMsg.length;
  const promptWords = Math.max(1, userMsg.trim().split(/\s+/).length);
  const responseWords = Math.max(1, assistantMsg.trim().split(/\s+/).length);
  // Estimate tokens: ~4 chars per token (mixed ID/EN).
  const responseTokens = Math.max(1, Math.round(responseLen / 4));
  const tps = latencyMs > 0 ? (responseTokens / latencyMs) * 1000 : 0;

  // --- Code detection ---
  const codeBlocks = (assistantMsg.match(/```[\s\S]*?```/g) || []).length;
  const inlineCode = (assistantMsg.match(/`[^`\n]+`/g) || []).length;
  const hasFunction = /\b(def |function |func |class |public |private |return |import |from )/.test(assistantMsg);
  const codeLines = (assistantMsg.match(/^\s*(if |for |while |return |print|def |class |import |from |const |let |var )/gm) || []).length;

  // --- Math detection ---
  const hasMathSymbols = /[∑∫π√≠≤≥±×÷∞²³]/.test(assistantMsg);
  const hasLatex = /\\(frac|sqrt|int|sum|alpha|beta|gamma|theta)/.test(assistantMsg);
  const hasNumbers = /\d+(\.\d+)?/.test(assistantMsg);
  const hasEquations = /[^=!<>]=[^\s=]/.test(assistantMsg);

  // --- Reasoning indicators ---
  const reasoningWords = (assistantMsg.toLowerCase().match(/\b(karena|oleh karena itu|sebab|akibatnya|pertama|kedua|ketiga|selanjutnya|namun|akan tetapi|sebaliknya|sehingga|makanya|jadi|therefore|because|thus|hence|consequently|first|second|third|however|moreover|furthermore|in conclusion|step|analysis|reason)\b/g) || []).length;
  const sentenceCount = (assistantMsg.match(/[.!?\n]+/g) || []).length;
  const avgSentenceLen = sentenceCount > 0 ? responseWords / sentenceCount : responseWords;

  // --- Knowledge/depth ---
  const responseDepth = responseWords / promptWords; // ratio output words per input word

  // === Compute scores 0-100 ===

  // Reasoning: density of connective reasoning words + structure (multi-sentence, longer).
  const reasoningDensity = reasoningWords / Math.max(1, responseWords);
  const reasoningScore = Math.min(100, Math.round(
    reasoningDensity * 250 +                       // up to ~40 from density
    (sentenceCount > 3 ? 25 : sentenceCount * 8) +  // up to ~25 from structure
    (responseWords > 50 ? 15 : 0) +                 // bonus for depth
    (responseWords > 150 ? 10 : 0)
  ));

  // Code: presence of code blocks, code lines, and function-like patterns.
  const codeScore = Math.min(100, Math.round(
    codeBlocks * 30 +
    Math.min(20, codeLines * 4) +
    (hasFunction ? 20 : 0) +
    Math.min(10, inlineCode * 2)
  ));

  // Math: presence of math symbols, latex, numbers, equations.
  const mathScore = Math.min(100, Math.round(
    (hasMathSymbols ? 35 : 0) +
    (hasLatex ? 30 : 0) +
    (hasEquations ? 20 : 0) +
    (hasNumbers ? 15 : 0)
  ));

  // Knowledge: response depth & richness.
  const knowledgeScore = Math.min(100, Math.round(
    Math.min(35, responseWords / 4) +            // up to 35 from length
    Math.min(25, responseLen / 60) +             // up to 25 from char depth
    Math.min(20, avgSentenceLen) +                // up to 20 from sentence richness
    Math.min(20, responseDepth * 5)               // up to 20 from output/input ratio
  ));

  // Speed: throughput tokens/sec normalized; ~100 tps ≈ 100 points.
  const speedScore = Math.min(100, Math.round(tps));

  // Coherence: structure & length sanity.
  const coherent = responseLen > 50 && sentenceCount >= 1 && avgSentenceLen < 30;
  const coherenceScore = Math.min(100, Math.round(
    (coherent ? 35 : 0) +
    (responseWords > 30 ? 20 : 0) +
    (sentenceCount > 2 ? 20 : sentenceCount * 7) +
    (avgSentenceLen > 5 && avgSentenceLen < 25 ? 25 : 10)
  ));

  const scores = {
    reasoning: reasoningScore,
    code: codeScore,
    math: mathScore,
    knowledge: knowledgeScore,
    speed: speedScore,
    coherence: coherenceScore,
  };
  const overall = Math.round(
    (reasoningScore + codeScore + mathScore + knowledgeScore + speedScore + coherenceScore) / 6
  );

  return {
    promptLen, responseLen, responseWords, responseTokens,
    latencyMs, tps: Math.round(tps * 10) / 10,
    codeBlocks, codeLines, inlineCode, hasFunction,
    hasMathSymbols, hasLatex, hasNumbers, hasEquations,
    reasoningWords, sentenceCount, avgSentenceLen,
    scores, overall,
    timestamp: Date.now(),
  };
}

/**
 * Map a benchmark LLM's public numbers to our 6 dimensions (0-100) so the
 * radar chart can overlay it on the user's profile.
 */
function llmBenchmarkToDimensions(b) {
  if (!b) return null;
  // Map: MMLU → Knowledge, HumanEval → Code, GSM8K → Math,
  // reasoning → Reasoning, speed_tps → Speed, and derive Coherence from MMLU.
  return {
    reasoning: b.reasoning,
    code: b.humaneval,
    math: Math.round((b.gsm8k + b.math) / 2),
    knowledge: b.mmlu,
    speed: Math.min(100, b.speed_tps),
    coherence: Math.round((b.mmlu + b.reasoning) / 2),
  };
}

function llmOverallScore(b) {
  if (!b) return 0;
  const d = llmBenchmarkToDimensions(b);
  return Math.round((d.reasoning + d.code + d.math + d.knowledge + d.speed + d.coherence) / 6);
}

/**
 * Aggregate the user's test results into a single averaged scores object.
 */
function aggregateUserScores() {
  if (state.benchmarkResults.length === 0) return null;
  const sum = { reasoning: 0, code: 0, math: 0, knowledge: 0, speed: 0, coherence: 0 };
  state.benchmarkResults.forEach((r) => {
    Object.keys(sum).forEach((k) => { sum[k] += r.analysis.scores[k]; });
  });
  const n = state.benchmarkResults.length;
  Object.keys(sum).forEach((k) => { sum[k] = Math.round(sum[k] / n); });
  return sum;
}

function aggregateUserOverall() {
  if (state.benchmarkResults.length === 0) return 0;
  const s = aggregateUserScores();
  return Math.round((s.reasoning + s.code + s.math + s.knowledge + s.speed + s.coherence) / 6);
}

/**
 * Find the verdict — which LLMs the user beats / loses to / is on par with.
 */
function computeVerdict() {
  const userOverall = aggregateUserOverall();
  if (userOverall === 0) return null;

  const comparisons = Object.entries(BENCHMARKS).map(([key, b]) => {
    const bOverall = llmOverallScore(b);
    return { key, name: b.name, color: b.color, overall: bOverall, diff: userOverall - bOverall };
  });
  comparisons.sort((a, b) => b.overall - a.overall);

  // Closest by absolute diff.
  const closest = comparisons.reduce((best, c) =>
    !best || Math.abs(c.diff) < Math.abs(best.diff) ? c : best, null);

  // LLMs we beat (positive diff).
  const beats = comparisons.filter((c) => c.diff > 0).sort((a, b) => a.diff - b.diff);
  // LLMs that beat us (negative diff).
  const losesTo = comparisons.filter((c) => c.diff < 0).sort((a, b) => b.diff - a.diff);

  return { userOverall, comparisons, closest, beats, losesTo };
}

// ---- Rendering ----
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

  // Detail: list who we beat & who we lose to.
  let detail = '';
  if (v.beats.length > 0) {
    const list = v.beats.slice(0, 3).map((b) =>
      `<span class="pos">${b.name}</span> (+${b.diff})`).join(', ');
    detail += `Beats ${v.beats.length} LLM: ${list}${v.beats.length > 3 ? '…' : ''}. `;
  }
  if (v.losesTo.length > 0) {
    const list = v.losesTo.slice(0, 3).map((b) =>
      `<span class="neg">${b.name}</span> (${b.diff})`).join(', ');
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
  const NS = 'http://www.w3.org/2000/svg';

  let html = '';
  // Concentric grid polygons (5 levels).
  for (let i = 1; i <= 5; i++) {
    const r = R * i / 5;
    const pts = DIMENSIONS.map((_, j) => {
      const angle = -Math.PI / 2 + j * 2 * Math.PI / n;
      return `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`;
    }).join(' ');
    html += `<polygon points="${pts}" fill="none" stroke="${i === 5 ? '#3f3f46' : '#27272a'}" stroke-width="1"/>`;
  }
  // Axis lines + labels.
  DIMENSIONS.forEach((d, i) => {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / n;
    const x = cx + R * Math.cos(angle);
    const y = cy + R * Math.sin(angle);
    html += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#3f3f46" stroke-width="1"/>`;
    const lx = cx + (R + 22) * Math.cos(angle);
    const ly = cy + (R + 22) * Math.sin(angle);
    html += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="#a1a1aa" font-size="10" font-weight="500" text-anchor="middle" dominant-baseline="middle">${d.label}</text>`;
    // Score label next to axis.
    const sx = cx + (R + 22) * Math.cos(angle);
    const sy = cy + (R + 22) * Math.sin(angle) + 12;
    html += `<text x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" fill="#10b981" font-size="9" font-family="JetBrains Mono, monospace" text-anchor="middle">${scores[d.key]}</text>`;
  });
  // Comparison polygon (background).
  if (cmpScores) {
    const cmpPts = DIMENSIONS.map((d, i) => {
      const angle = -Math.PI / 2 + i * 2 * Math.PI / n;
      const r = R * (cmpScores[d.key] / 100);
      return `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`;
    }).join(' ');
    html += `<polygon points="${cmpPts}" fill="rgba(161,161,170,0.10)" stroke="#71717a" stroke-width="1.5" stroke-dasharray="3,2"/>`;
  }
  // User polygon.
  const userPts = DIMENSIONS.map((d, i) => {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / n;
    const r = R * (scores[d.key] / 100);
    return `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`;
  }).join(' ');
  html += `<polygon points="${userPts}" fill="rgba(16,185,129,0.30)" stroke="#10b981" stroke-width="2"/>`;
  // Vertex dots.
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

  // Build data rows: user + all benchmarks.
  const rows = [{ name: "User's LLM", score: userOverall, color: '#10b981', isUser: true }];
  Object.entries(BENCHMARKS).forEach(([key, b]) => {
    rows.push({ name: b.name, score: llmOverallScore(b), color: b.color, isUser: false });
  });
  rows.sort((a, b) => b.score - a.score);

  const H = padding.top + padding.bottom + rows.length * rowH;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  let html = '';
  // Grid lines at 25/50/75/100.
  [25, 50, 75, 100].forEach((v) => {
    const x = padding.left + chartW * v / 100;
    html += `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${H - padding.bottom}" stroke="#27272a" stroke-width="1" stroke-dasharray="2,3"/>`;
    html += `<text x="${x}" y="${H - 2}" fill="#52525b" font-size="9" text-anchor="middle">${v}</text>`;
  });

  rows.forEach((r, i) => {
    const y = padding.top + i * rowH + 4;
    // Label.
    html += `<text x="${padding.left - 8}" y="${y + barH / 2 + 4}" fill="${r.isUser ? '#10b981' : '#a1a1aa'}" font-size="11" font-weight="${r.isUser ? 700 : 500}" text-anchor="end">${r.name}</text>`;
    // Bar background.
    html += `<rect x="${padding.left}" y="${y}" width="${chartW}" height="${barH}" fill="#27272a" rx="2"/>`;
    // Bar fill.
    const barW = chartW * r.score / 100;
    html += `<rect x="${padding.left}" y="${y}" width="${barW.toFixed(1)}" height="${barH}" fill="${r.color}" rx="2" ${r.isUser ? 'stroke="#34d399" stroke-width="1"' : ''}/>`;
    // Score text.
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
  // Newest first.
  const sorted = [...state.benchmarkResults].reverse();
  let html = '';
  sorted.forEach((r) => {
    const time = new Date(r.ts).toLocaleTimeString('id-ID', { hour12: false });
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

// ---------------------------------------------------------------------------
// Drag & drop wiring
// ---------------------------------------------------------------------------
function wireDropzone() {
  const dz = $('#dropzone');
  const input = $('#file-input');

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });

  input.addEventListener('change', () => {
    if (input.files.length) uploadFiles(input.files);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    dz.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dz.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.remove('drag-over');
    });
  });
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
  });

  // Allow dropping anywhere on the page too
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length && !dz.contains(e.target)) {
      uploadFiles(e.dataTransfer.files);
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  connectSocket();
  wireDropzone();

  // Tab buttons
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // Header buttons
  $('#run-btn').addEventListener('click', handleRun);
  $('#stop-btn').addEventListener('click', handleStop);

  // Clear files
  $('#clear-files-btn').addEventListener('click', clearAllFiles);

  // Console
  $('#clear-console-btn').addEventListener('click', () => {
    state.consoleLines = [];
    renderConsole();
  });

  // Chat
  $('#chat-input').addEventListener('input', renderChatInput);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage();
    }
  });
  $('#chat-send-btn').addEventListener('click', sendMessage);
  $('#chat-stop-btn').addEventListener('click', stopChat);
  $('#clear-chat-btn').addEventListener('click', clearChat);

  // Benchmark
  $('#radar-compare-select').addEventListener('change', (e) => {
    state.radarCompareKey = e.target.value;
    renderRadarChart();
  });
  $('#clear-benchmark-btn').addEventListener('click', () => {
    state.benchmarkResults = [];
    renderBenchmark();
    log('Benchmark cleared.', 'info');
  });

  // Initial render
  renderConnection();
  renderFiles();
  renderRunState();
  renderConsole();
  renderChatMessages();
  renderChatInput();
  renderBenchmark();

  // Refresh file list from server (in case there's stale state)
  refreshFiles();
  // Fetch real device specs (CPU, RAM, GPU model) for the Device card
  fetchDeviceInfo();
}

document.addEventListener('DOMContentLoaded', init);
