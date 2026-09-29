/* ColabGPU — vanilla JavaScript, no framework */

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
};

const MAX_HISTORY = 60;
const MAX_CONSOLE = 200;
const MAX_CHAT = 100;

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
    log('Telemetry stream connected.', 'success');
    renderConnection();
  });

  socket.on('disconnect', () => {
    state.connected = false;
    log('Telemetry stream disconnected.', 'warn');
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
    if (s.runState === 'loading') log('Loading model into VRAM…', 'info');
    else if (s.runState === 'running') log('Model ready — inference server online.', 'success');
    else if (s.runState === 'stopped') log('Run stopped by user.', 'warn');
    else if (s.runState === 'idle') log('Session idle.', 'info');
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
  log(`Mengunggah ${files.length} file: ${files.map((f) => f.name).join(', ')}`, 'info');
  try {
    const formData = new FormData();
    files.forEach((f) => formData.append('files', f));
    const res = await fetch('/api/files', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.files = data.files;
    const totalBytes = data.created.reduce((a, f) => a + f.sizeBytes, 0);
    log(`Berhasil upload ${data.created.length} file (${humanSize(totalBytes)}).`, 'success');
    renderFiles();
    renderRunState();
  } catch (e) {
    log(`Gagal upload: ${e.message}`, 'error');
  } finally {
    $('#dropzone').classList.remove('uploading');
  }
}

async function deleteFile(id) {
  try {
    const res = await fetch(`/api/files?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.files = state.files.filter((f) => f.id !== id);
    log(`File dihapus.`, 'info');
    renderFiles();
    renderRunState();
  } catch (e) {
    log(`Gagal hapus: ${e.message}`, 'error');
  }
}

async function clearAllFiles() {
  for (const f of state.files) {
    try {
      await fetch(`/api/files?id=${encodeURIComponent(f.id)}`, { method: 'DELETE' });
    } catch (e) { /* ignore */ }
  }
  state.files = [];
  log('Semua file dibersihkan.', 'info');
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
  log(`Run dispatched for model: ${model ?? '(no model)'}`, 'info');
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
  log('Stop dispatched.', 'warn');
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
          } else if (evt.type === 'error') {
            $('#chat-error').textContent = evt.message;
            $('#chat-error').classList.remove('hidden');
            const msg = state.chatMessages.find((m) => m.id === assistantId);
            if (msg) msg.streaming = false;
          }
        } catch { /* skip */ }
      }
    }
    log('Chat response complete.', 'success');
    renderChatMessages();
  } catch (e) {
    if (e.name === 'AbortError') {
      log('Chat dibatalkan oleh user.', 'warn');
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
    ft.innerHTML = '<span class="dot"></span> telemetry live';
  } else {
    cs.classList.remove('online');
    $('#conn-text').textContent = 'offline';
    ft.classList.remove('online');
    ft.innerHTML = '<span class="dot"></span> telemetry offline';
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

function renderMetrics() {
  if (!state.metrics) return;
  const m = state.metrics;
  $('#status-time').textContent = new Date(m.ts).toLocaleTimeString('id-ID', { hour12: false });

  // GPU
  const gpuUtil = m.gpu.utilization;
  $('#gpu-util').textContent = gpuUtil.toFixed(1);
  $('#gpu-util-bar').style.width = `${gpuUtil}%`;
  $('#gpu-vram').textContent = m.gpu.memoryUsedGb.toFixed(1);
  $('#gpu-vram-total').textContent = m.gpu.memoryTotalGb.toFixed(0);
  const gpuMemPct = (m.gpu.memoryUsedGb / m.gpu.memoryTotalGb) * 100;
  $('#gpu-mem').textContent = gpuMemPct.toFixed(1);
  $('#gpu-mem-bar').style.width = `${gpuMemPct}%`;
  // Apply accent to GPU cards
  const cards = $$('#tab-dashboard .metric-card');
  if (cards[0]) applyAccentClass(cards[0], gpuUtil);
  if (cards[1]) applyAccentClass(cards[1], gpuMemPct);

  // RAM
  const ramPct = (m.ram.usedGb / m.ram.totalGb) * 100;
  $('#ram-pct').textContent = ramPct.toFixed(0);
  $('#ram-used').textContent = m.ram.usedGb.toFixed(1);
  $('#ram-total').textContent = m.ram.totalGb;
  $('#ram-bar').style.width = `${ramPct}%`;
  if (cards[2]) applyAccentClass(cards[2], ramPct);

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

  // Secondary metrics
  $('#gpu-temp').textContent = m.gpu.tempC.toFixed(0);
  $('#gpu-power').textContent = m.gpu.powerW.toFixed(0);
  $('#net-rx').textContent = m.net.rxMbps.toFixed(1);
  $('#net-tx').textContent = m.net.txMbps.toFixed(1);

  // Footer summary
  $('#footer-gpu').textContent = gpuUtil.toFixed(0);
  $('#footer-ram').textContent = ramPct.toFixed(0);
  $('#footer-ssd').textContent = ssdPct.toFixed(0);
  $('#footer-files').textContent = state.files.length;

  // Sparklines
  drawSparkline('#gpu-mem-spark', state.metricsHistory.map((x) => (x.gpu.memoryUsedGb / x.gpu.memoryTotalGb) * 100), '#10b981');
  drawSparkline('#ram-spark', state.metricsHistory.map((x) => (x.ram.usedGb / x.ram.totalGb) * 100), '#06b6d4');

  // Big chart
  const avg = state.gpuUtilHistory.length
    ? state.gpuUtilHistory.reduce((a, b) => a + b, 0) / state.gpuUtilHistory.length
    : 0;
  $('#gpu-avg').textContent = avg.toFixed(1);
  drawLineChart('#gpu-chart', state.gpuUtilHistory, '#10b981', 100);
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
    txt.textContent = 'Model aktif — inference berjalan';
  } else if (state.runState === 'loading') {
    dot.classList.add('loading');
    txt.textContent = 'Memuat model ke VRAM…';
  } else if (state.runState === 'error') {
    dot.classList.add('error');
    txt.textContent = 'Terjadi error';
  } else if (state.runState === 'stopped') {
    txt.textContent = 'Run dihentikan';
  } else {
    txt.textContent = 'Sistem idle';
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
      ? 'Klik tombol Run di header dulu untuk load model. Setelah status berubah "running", chat ini aktif.'
      : 'Ketik pesan dan tekan Cmd/Ctrl+Enter atau klik tombol kirim. Response stream token-by-token.';
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
        <p class="empty-title">Belum ada file</p>
        <p class="empty-sub">Drag & drop LLM, dataset, atau config</p>
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
    out.innerHTML = '<div class="console-empty">Belum ada output. Drag & drop file lalu klik Run untuk mulai.</div>';
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
    container.innerHTML = `
      <div class="chat-empty">
        <div class="chat-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        </div>
        <p class="ce-title">Test LLM yang sudah di-load</p>
        <p id="ce-sub" class="ce-sub">${state.runState !== 'running'
          ? 'Klik tombol Run di header dulu untuk load model. Setelah status berubah "running", chat ini aktif.'
          : 'Ketik pesan dan tekan Cmd/Ctrl+Enter atau klik tombol kirim. Response stream token-by-token.'}</p>
        <div class="ce-suggestions">
          <button class="suggestion">Jelaskan apa itu WebGPU</button>
          <button class="suggestion">Tulis fungsi Python quicksort</button>
          <button class="suggestion">Berikan 5 ide nama startup AI</button>
        </div>
      </div>`;
    $$('.suggestion').forEach((b) => {
      b.addEventListener('click', () => {
        $('#chat-input').value = b.textContent;
        $('#chat-input').focus();
      });
    });
    return;
  }

  const USER_AVATAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  const AI_AVATAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';

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
    input.placeholder = 'Ketik pesan… (Cmd/Ctrl+Enter untuk kirim)';
  } else {
    input.disabled = true;
    input.placeholder = 'Run model dulu sebelum chat…';
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

  // Initial render
  renderConnection();
  renderFiles();
  renderRunState();
  renderConsole();
  renderChatMessages();
  renderChatInput();

  // Welcome
  log('ColabGPU siap. Drag & drop file LLM/dataset ke sidebar, lalu klik Run.', 'info');

  // Refresh file list from server (in case there's stale state)
  refreshFiles();
}

document.addEventListener('DOMContentLoaded', init);
