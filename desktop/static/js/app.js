/* SynapGPU Desktop — Frontend
 *
 * Simple profiler UI. No drag-drop-run flow (that's for the web version).
 * Desktop is for: open app → see real device specs → see live metrics →
 * (optionally) test local LLM and compare to public benchmarks.
 */
'use strict';

const state = {
  deviceInfo: null,
  benchmarks: {},
  benchmarkSource: '',
  localLlms: {},
  activeLlm: null,
  metrics: null,
  metricsHistory: [],
  gpuUtilHistory: [],
  ssdReadHistory: [],
  cpuUtilHistory: [],
  connected: false,
  consoleLines: [],
  chatMessages: [],
  chatStreaming: false,
  chatAbortController: null,
  benchmarkResults: [],
  radarCompareKey: null,
};

const MAX_HISTORY = 60;
const MAX_CONSOLE = 200;
const MAX_CHAT = 100;
const MAX_BENCHMARK = 50;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function log(text, level = 'info') {
  state.consoleLines.push({ id: uid(), ts: Date.now(), level, text });
  if (state.consoleLines.length > MAX_CONSOLE) state.consoleLines.shift();
  renderConsole();
}

// ===========================================================================
// WebSocket connection to local Python backend
// ===========================================================================
function connectSocket() {
  const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1200,
    timeout: 10000,
  });
  socket.on('connect', () => {
    state.connected = true;
    log('Connected to local backend.', 'success');
    renderConnection();
  });
  socket.on('disconnect', () => {
    state.connected = false;
    log('Backend disconnected.', 'warn');
    renderConnection();
  });
  socket.on('metrics', (m) => {
    state.metrics = m;
    state.metricsHistory.push(m);
    if (state.metricsHistory.length > MAX_HISTORY) state.metricsHistory.shift();
    if (m.gpu && m.gpu.available && m.gpu.utilization !== undefined) {
      state.gpuUtilHistory.push(m.gpu.utilization);
      if (state.gpuUtilHistory.length > MAX_HISTORY) state.gpuUtilHistory.shift();
    }
    state.ssdReadHistory.push(m.ssd.readMbps);
    if (state.ssdReadHistory.length > MAX_HISTORY) state.ssdReadHistory.shift();
    renderMetrics();
  });
}

// ===========================================================================
// Fetch device info, benchmarks, local LLMs from backend
// ===========================================================================
async function fetchDeviceInfo() {
  try {
    const res = await fetch('/api/device-info');
    if (res.ok) {
      state.deviceInfo = await res.json();
      renderDeviceInfo();
    }
  } catch (e) { log(`Device info fetch failed: ${e.message}`, 'error'); }
}

async function fetchBenchmarks() {
  try {
    const res = await fetch('/api/benchmarks');
    if (res.ok) {
      const data = await res.json();
      state.benchmarks = data.benchmarks || {};
      state.benchmarkSource = data.source || 'unknown';
      const count = Object.keys(state.benchmarks).length;
      log(`Loaded ${count} LLM benchmarks (${state.benchmarkSource}).`, 'success');
      renderBenchmarkSource();
      renderBenchmark();
    }
  } catch (e) { log(`Benchmark fetch failed: ${e.message}`, 'error'); }
}

async function fetchLocalLlms() {
  try {
    const res = await fetch('/api/local-llms');
    if (res.ok) {
      const data = await res.json();
      state.localLlms = data.servers || {};
      state.activeLlm = data.active ? data.active.name : null;
      const keys = Object.keys(state.localLlms);
      if (keys.length > 0) {
        log(`Local LLM detected: ${keys.join(', ')}`, 'success');
        $('#ce-sub').textContent = `Type a message and press Cmd/Ctrl+Enter to send. Routes to ${state.activeLlm}.`;
        $('#chat-input').disabled = false;
        $('#chat-input').placeholder = 'Type a message… (Cmd/Ctrl+Enter to send)';
        $('#chat-send-btn').disabled = false;
        $('#chat-model-badge').textContent = state.activeLlm;
        $('#chat-model-badge').classList.remove('hidden');
      } else {
        log('No local LLM detected. Install Ollama, llama.cpp, or LM Studio to enable chat.', 'warn');
      }
      renderLocalLlms();
      renderLlmServerBadge();
    }
  } catch (e) { /* ignore */ }
}

async function rescanLocalLlms() {
  $('#llm-servers-list').innerHTML = '<div class="llm-empty">Rescanning…</div>';
  await fetchLocalLlms();
}

// ===========================================================================
// Chat (real backend — routes to Ollama / llama.cpp / LM Studio)
// ===========================================================================
const SYSTEM_PROMPT = 'You are a helpful AI assistant. Answer clearly and concisely.';

async function sendMessage() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || state.chatStreaming) return;

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
    if (!res.ok || !res.body) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }
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
            const analysis = analyzeResponse(text, msg ? msg.content : '', evt.latencyMs || 0);
            state.benchmarkResults.push({
              id: uid(), prompt: text, response: msg ? msg.content : '', analysis, ts: Date.now(),
            });
            if (state.benchmarkResults.length > MAX_BENCHMARK) {
              state.benchmarkResults = state.benchmarkResults.slice(-MAX_BENCHMARK);
            }
            renderBenchmark();
            log(`Scored ${analysis.overall}/100`, 'info');
          } else if (evt.type === 'error') {
            $('#chat-error').textContent = evt.message;
            $('#chat-error').classList.remove('hidden');
            const msg = state.chatMessages.find((m) => m.id === assistantId);
            if (msg) msg.streaming = false;
          }
        } catch {}
      }
    }
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
  } finally {
    state.chatStreaming = false;
    state.chatAbortController = null;
    renderChatInput();
    renderChatMessages();
  }
}

function stopChat() {
  if (state.chatAbortController) state.chatAbortController.abort();
}

function clearChat() {
  state.chatMessages = [];
  renderChatMessages();
}

// ===========================================================================
// Benchmark analyzer
// ===========================================================================
const DIMENSIONS = [
  { key: 'reasoning', label: 'Reasoning', hint: 'Logical & multi-step thinking' },
  { key: 'code', label: 'Code', hint: 'Code blocks & function defs' },
  { key: 'math', label: 'Math', hint: 'Numbers, formulas, equations' },
  { key: 'knowledge', label: 'Knowledge', hint: 'Depth & richness of content' },
  { key: 'speed', label: 'Speed', hint: 'Throughput (tokens/sec)' },
  { key: 'coherence', label: 'Coherence', hint: 'Sentence structure sanity' },
];

function analyzeResponse(userMsg, assistantMsg, latencyMs) {
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
  const reasoningWords = (assistantMsg.toLowerCase().match(/\b(therefore|because|thus|hence|consequently|first|second|third|however|moreover|furthermore|step|analysis|reason)\b/g) || []).length;
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
  return { responseLen, responseWords, responseTokens, latencyMs, tps: Math.round(tps * 10) / 10, codeBlocks, codeLines, hasFunction, hasMathSymbols, hasLatex, hasNumbers, hasEquations, reasoningWords, sentenceCount, avgSentenceLen, scores, overall, timestamp: Date.now() };
}

function llmBenchmarkToDimensions(b) {
  if (!b) return null;
  return { reasoning: b.reasoning || 70, code: b.humaneval || 0, math: Math.round(((b.gsm8k || 0) + (b.math || 0)) / 2), knowledge: b.mmlu || 0, speed: Math.min(100, b.speed_tps || 0), coherence: Math.round(((b.mmlu || 0) + (b.reasoning || 70)) / 2) };
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
  const benchmarks = state.benchmarks || {};
  const comparisons = Object.entries(benchmarks).map(([key, b]) => {
    const bOverall = llmOverallScore(b);
    return { key, name: b.name, color: b.color, overall: bOverall, diff: userOverall - bOverall, source: b.source };
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
function statusAccent(p) { return p >= 90 ? 'rose' : p >= 70 ? 'amber' : 'emerald'; }
function applyAccentClass(card, p) { card.setAttribute('data-accent', statusAccent(p)); }

function renderConnection() {
  const cs = $('#conn-status');
  const ft = $('#footer-conn');
  if (state.connected) {
    cs.classList.add('online'); $('#conn-text').textContent = 'live';
    ft.classList.add('online'); ft.innerHTML = '<span class="indicator-dot"></span> live';
  } else {
    cs.classList.remove('online'); $('#conn-text').textContent = 'offline';
    ft.classList.remove('online'); ft.innerHTML = '<span class="indicator-dot"></span> offline';
  }
}

function renderLlmServerBadge() {
  const badge = $('#llm-server-badge');
  const text = $('#llm-server-text');
  const keys = Object.keys(state.localLlms);
  if (keys.length > 0) {
    badge.classList.add('online');
    text.textContent = state.activeLlm || keys[0];
  } else {
    badge.classList.remove('online');
    text.textContent = 'no LLM';
  }
}

function renderDeviceInfo() {
  const info = state.deviceInfo;
  if (!info) return;
  $('#dc-platform').textContent = `${info.platform || ''} ${info.platform_release || ''}`.trim();
  $('#spec-cpu').textContent = info.cpu.model;
  $('#spec-cpu').title = info.cpu.model;
  $('#spec-cores').textContent = `${info.cpu.coresPhysical} physical · ${info.cpu.coresLogical} logical`;
  $('#spec-ram').textContent = `${info.ram.totalGb} GB`;
  $('#spec-disk').textContent = `${info.disk.totalGb} GB`;
  if (info.gpu.available) {
    $('#spec-gpu').textContent = info.gpu.name;
    $('#spec-gpu').classList.add('accent');
    $('#spec-vram').textContent = `${info.gpu.vramTotalGb} GB`;
    $('#spec-vram').classList.add('accent');
    // Pre-fill live metrics GPU card totals
    $('#gpu-vram-total').textContent = info.gpu.vramTotalGb.toFixed(0);
    $('#gpu-metric-card').classList.remove('hidden');
    $('#gpu-chart-card').classList.remove('hidden');
  } else {
    $('#spec-gpu').textContent = 'Not detected';
    $('#spec-gpu').classList.add('muted');
    $('#spec-vram').textContent = '—';
    $('#spec-vram').classList.add('muted');
    $('#gpu-metric-card').classList.add('hidden');
    $('#gpu-chart-card').classList.add('hidden');
  }
  $('#spec-platform').textContent = `${info.platform} ${info.platform_release} (${info.machine})`;
  $('#spec-python').textContent = info.python_version;
  $('#cpu-cores-footer').textContent = `${info.cpu.coresLogical} logical cores`;
  $('#ram-total').textContent = info.ram.totalGb;
  $('#ssd-total').textContent = info.disk.totalGb;
}

function renderBenchmarkSource() {
  const count = Object.keys(state.benchmarks).length;
  $('#dc-bench-source').textContent = state.benchmarkSource;
  $('#bench-source-text').textContent = `Loaded ${count} LLM benchmark entries from ${state.benchmarkSource}. Data refreshes hourly to stay current with leaderboard updates.`;
}

function renderLocalLlms() {
  const list = $('#llm-servers-list');
  const keys = Object.keys(state.localLlms);
  if (keys.length === 0) {
    list.innerHTML = '<div class="llm-empty">None detected. Install one of: Ollama, llama.cpp server, or LM Studio, then click Rescan.</div>';
    return;
  }
  let html = '';
  keys.forEach((k) => {
    const srv = state.localLlms[k];
    const isActive = k === state.activeLlm;
    html += `
      <div class="llm-row ${isActive ? 'active' : ''}">
        <div class="llm-info">
          <span class="llm-name">${escapeHtml(k)}</span>
          <span class="llm-url">${escapeHtml(srv.base || srv.url)}</span>
        </div>
        ${isActive ? '<span class="llm-active-tag">active</span>' : ''}
      </div>`;
  });
  list.innerHTML = html;
}

function renderMetrics() {
  if (!state.metrics) return;
  const m = state.metrics;
  $('#status-time').textContent = new Date(m.ts).toLocaleTimeString('en-US', { hour12: false });

  const cpuUtil = m.cpu?.utilization ?? 0;
  state.cpuUtilHistory.push(cpuUtil);
  if (state.cpuUtilHistory.length > MAX_HISTORY) state.cpuUtilHistory.shift();
  $('#cpu-util').textContent = cpuUtil.toFixed(1);
  $('#cpu-util-bar').style.width = `${cpuUtil}%`;
  const cpuCard = $('#tab-live .metric-card[data-accent="emerald"]');
  if (cpuCard) applyAccentClass(cpuCard, cpuUtil);

  if (m.gpu.available && m.gpu.utilization !== undefined) {
    const gpuUtil = m.gpu.utilization;
    $('#gpu-util').textContent = gpuUtil.toFixed(1);
    $('#gpu-util-bar').style.width = `${gpuUtil}%`;
    $('#gpu-vram').textContent = m.gpu.memoryUsedGb.toFixed(1);
    const gpuMemPct = (m.gpu.memoryUsedGb / m.gpu.memoryTotalGb) * 100;
    $('#gpu-temp-wrap').textContent = `${m.gpu.tempC.toFixed(0)}°C`;
    $('#gpu-power-wrap').textContent = `${m.gpu.powerW.toFixed(0)} W`;
    const gpuCard = $('#gpu-metric-card');
    if (gpuCard) applyAccentClass(gpuCard, gpuUtil);
    const avg = state.gpuUtilHistory.length ? state.gpuUtilHistory.reduce((a, b) => a + b, 0) / state.gpuUtilHistory.length : 0;
    $('#gpu-avg').textContent = avg.toFixed(1);
    drawLineChart('#gpu-chart', state.gpuUtilHistory, '#10b981', 100);
  }

  const ramPct = (m.ram.usedGb / m.ram.totalGb) * 100;
  $('#ram-pct').textContent = ramPct.toFixed(0);
  $('#ram-used').textContent = m.ram.usedGb.toFixed(2);
  $('#ram-total').textContent = m.ram.totalGb;
  $('#ram-bar').style.width = `${ramPct}%`;
  const ramCard = $('#tab-live .metric-card[data-accent="amber"]');
  if (ramCard) applyAccentClass(ramCard, ramPct);

  const ssdPct = (m.ssd.usedGb / m.ssd.totalGb) * 100;
  $('#ssd-pct').textContent = ssdPct.toFixed(1);
  $('#ssd-used').textContent = m.ssd.usedGb.toFixed(0);
  $('#ssd-total').textContent = m.ssd.totalGb;
  $('#ssd-bar').style.width = `${ssdPct}%`;
  $('#ssd-read').textContent = m.ssd.readMbps.toFixed(0);
  $('#ssd-write').textContent = m.ssd.writeMbps.toFixed(0);
  $('#ssd-read-2').textContent = m.ssd.readMbps.toFixed(0);
  $('#ssd-write-2').textContent = m.ssd.writeMbps.toFixed(0);
  const ssdCard = $('#tab-live .metric-card[data-accent="rose"]');
  if (ssdCard) applyAccentClass(ssdCard, ssdPct);

  $('#net-rx').textContent = m.net.rxMbps.toFixed(1);
  $('#net-tx').textContent = m.net.txMbps.toFixed(1);
  $('#footer-gpu').textContent = m.gpu.available ? (m.gpu.utilization ?? 0).toFixed(0) : '—';
  $('#footer-ram').textContent = ramPct.toFixed(0);
  $('#footer-ssd').textContent = ssdPct.toFixed(0);
  drawSparkline('#ram-spark', state.metricsHistory.map((x) => (x.ram.usedGb / x.ram.totalGb) * 100), '#06b6d4');
  drawLineChart('#ssd-chart', state.ssdReadHistory, '#f59e0b', 1000);
}

function drawSparkline(sel, data, color) {
  const svg = $(sel); if (!svg) return;
  svg.innerHTML = '';
  if (data.length < 2) return;
  const W = 200, H = 40;
  const max = Math.max(...data, 1), min = Math.min(...data, 0), range = max - min || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * W).toFixed(1)},${(H - ((v - min) / range) * H).toFixed(1)}`).join(' ');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  p.setAttribute('points', pts); p.setAttribute('fill', 'none'); p.setAttribute('stroke', color);
  p.setAttribute('stroke-width', '1.5'); p.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(p);
}

function drawLineChart(sel, data, color, maxY) {
  const svg = $(sel); if (!svg) return;
  svg.innerHTML = '';
  if (data.length < 2) return;
  const vb = svg.getAttribute('viewBox').split(' ').map(Number);
  const W = vb[2], H = vb[3];
  const max = Math.max(...data, 1, maxY ? maxY * 0.1 : 0), range = max || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * W).toFixed(1)},${(H - (v / range) * H).toFixed(1)}`).join(' ');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  poly.setAttribute('points', `0,${H} ${pts} ${W},${H}`);
  poly.setAttribute('fill', color); poly.setAttribute('fill-opacity', '0.15');
  svg.appendChild(poly);
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', pts); line.setAttribute('fill', 'none'); line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '1.5'); line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(line);
}

function renderConsole() {
  const out = $('#console-output');
  $('#console-count').textContent = `${state.consoleLines.length} lines`;
  if (state.consoleLines.length === 0) {
    out.innerHTML = '<div class="console-empty">No output yet.</div>'; return;
  }
  const ICONS = { info: 'ℹ', warn: '⚠', error: '✗', success: '✓' };
  let html = '';
  state.consoleLines.forEach((l) => {
    const ts = new Date(l.ts).toLocaleTimeString('en-US', { hour12: false });
    html += `<div class="console-line ${l.level}"><span class="ts">${ts}</span><span class="level">${ICONS[l.level] || 'ℹ'}</span><span class="text">${escapeHtml(l.text)}</span></div>`;
  });
  out.innerHTML = html; out.scrollTop = out.scrollHeight;
}

function renderChatMessages() {
  const container = $('#chat-messages');
  if (state.chatMessages.length === 0) {
    const sub = state.activeLlm
      ? `Type a message and press Cmd/Ctrl+Enter to send. Routes to ${state.activeLlm}.`
      : 'No local LLM detected. Install Ollama, llama.cpp, or LM Studio to test chat.';
    container.innerHTML = `<div class="chat-empty"><p class="ce-sub">${sub}</p></div>`; return;
  }
  const USER_AVATAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  const AI_AVATAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg>';
  let html = '';
  state.chatMessages.forEach((m) => {
    const isUser = m.role === 'user';
    const avatar = isUser ? USER_AVATAR : AI_AVATAR;
    let content = escapeHtml(m.content);
    if (m.streaming && !m.content) content = '<span class="chat-thinking">thinking…</span>';
    else if (m.streaming) content += '<span class="chat-cursor"></span>';
    const meta = m.latencyMs ? `<div class="chat-meta">${(m.latencyMs / 1000).toFixed(2)}s</div>` : '';
    html += `<div class="chat-message ${m.role}"><div class="chat-avatar ${m.role}">${avatar}</div><div class="chat-bubble-wrap"><div class="chat-bubble">${content}</div>${meta}</div></div>`;
  });
  container.innerHTML = html; container.scrollTop = container.scrollHeight;
}

function renderChatInput() {
  const input = $('#chat-input'), sendBtn = $('#chat-send-btn'), stopBtn = $('#chat-stop-btn');
  if (state.activeLlm) {
    input.disabled = false;
    input.placeholder = 'Type a message… (Cmd/Ctrl+Enter to send)';
  } else {
    input.disabled = true;
    input.placeholder = 'Install Ollama to chat…';
  }
  if (state.chatStreaming) {
    sendBtn.classList.add('hidden'); stopBtn.classList.remove('hidden');
  } else {
    sendBtn.classList.remove('hidden'); stopBtn.classList.add('hidden');
    sendBtn.disabled = !state.activeLlm || !input.value.trim();
  }
}

// ===========================================================================
// Benchmark rendering
// ===========================================================================
function renderBenchmark() {
  const empty = $('#benchmark-empty'), content = $('#benchmark-content'), tabPulse = $('#benchmark-tab-pulse');
  if (state.benchmarkResults.length === 0) {
    empty.classList.remove('hidden'); content.classList.add('hidden'); tabPulse.classList.add('hidden'); return;
  }
  empty.classList.add('hidden'); content.classList.remove('hidden'); tabPulse.classList.remove('hidden');
  renderVerdict(); renderDimScores(); renderRadarChart(); renderBarChart(); renderTestHistory(); renderCompareSelect();
}

function renderVerdict() {
  const v = computeVerdict();
  const tc = state.benchmarkResults.length;
  $('#verdict-tests-count').textContent = `${tc} test${tc === 1 ? '' : 's'}`;
  if (!v) { $('#verdict-main').innerHTML = '<span class="dim">No data yet.</span>'; $('#verdict-detail').textContent = ''; return; }
  const closest = v.closest, onPar = Math.abs(closest.diff) <= 3;
  let mainHtml;
  if (onPar) mainHtml = `On par with <span class="highlight">${closest.name}</span> <span class="dim">(${Math.abs(closest.diff)} pts · ${v.userOverall} vs ${closest.overall})</span>`;
  else if (closest.diff > 0) mainHtml = `Beats <span class="highlight">${closest.name}</span> <span class="dim">(+${closest.diff} pts · ${v.userOverall} vs ${closest.overall})</span>`;
  else mainHtml = `Slightly below <span class="highlight">${closest.name}</span> <span class="dim">(${Math.abs(closest.diff)} pts · ${v.userOverall} vs ${closest.overall})</span>`;
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
  if (state.benchmarkSource) detail += ` <span class="dim">Source: ${escapeHtml(state.benchmarkSource)}.</span>`;
  $('#verdict-detail').innerHTML = detail || 'Your LLM is in a unique position.';
}

function renderDimScores() {
  const scores = aggregateUserScores();
  const container = $('#dim-scores');
  if (!scores) { container.innerHTML = ''; return; }
  let html = '';
  DIMENSIONS.forEach((d) => {
    const v = scores[d.key];
    html += `<div class="dim-row"><div class="dim-label-row"><span class="dim-label">${d.label}</span><span class="dim-value">${v}/100</span></div><div class="dim-bar-bg"><div class="dim-bar" style="width:${v}%"></div></div><div class="dim-hint">${d.hint}</div></div>`;
  });
  container.innerHTML = html;
}

function renderCompareSelect() {
  const sel = $('#radar-compare-select');
  if (!sel) return;
  let opts = '';
  Object.entries(state.benchmarks).forEach(([key, b]) => { opts += `<option value="${key}">${b.name}</option>`; });
  sel.innerHTML = opts;
  if (!state.radarCompareKey || !(state.radarCompareKey in state.benchmarks)) {
    state.radarCompareKey = Object.keys(state.benchmarks)[0] || null;
  }
  sel.value = state.radarCompareKey || '';
}

function renderRadarChart() {
  const scores = aggregateUserScores();
  if (!scores) return;
  const cmp = state.benchmarks[state.radarCompareKey];
  const cmpScores = llmBenchmarkToDimensions(cmp);
  $('#radar-compare-name').textContent = cmp ? cmp.name : '—';
  const svg = $('#radar-user');
  const W = 320, H = 280, cx = W / 2, cy = H / 2 + 8, R = 95, n = DIMENSIONS.length;
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const r = R * i / 5;
    const pts = DIMENSIONS.map((_, j) => { const a = -Math.PI / 2 + j * 2 * Math.PI / n; return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`; }).join(' ');
    html += `<polygon points="${pts}" fill="none" stroke="${i === 5 ? '#3f3f46' : '#27272a'}" stroke-width="1"/>`;
  }
  DIMENSIONS.forEach((d, i) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / n;
    html += `<line x1="${cx}" y1="${cy}" x2="${(cx + R * Math.cos(a)).toFixed(1)}" y2="${(cy + R * Math.sin(a)).toFixed(1)}" stroke="#3f3f46" stroke-width="1"/>`;
    const lx = cx + (R + 22) * Math.cos(a), ly = cy + (R + 22) * Math.sin(a);
    html += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="#a1a1aa" font-size="10" font-weight="500" text-anchor="middle" dominant-baseline="middle">${d.label}</text>`;
    html += `<text x="${lx.toFixed(1)}" y="${(ly + 12).toFixed(1)}" fill="#10b981" font-size="9" font-family="JetBrains Mono, monospace" text-anchor="middle">${scores[d.key]}</text>`;
  });
  if (cmpScores) {
    const cmpPts = DIMENSIONS.map((d, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; const r = R * (cmpScores[d.key] / 100); return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`; }).join(' ');
    html += `<polygon points="${cmpPts}" fill="rgba(161,161,170,0.10)" stroke="#71717a" stroke-width="1.5" stroke-dasharray="3,2"/>`;
  }
  const userPts = DIMENSIONS.map((d, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; const r = R * (scores[d.key] / 100); return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`; }).join(' ');
  html += `<polygon points="${userPts}" fill="rgba(16,185,129,0.30)" stroke="#10b981" stroke-width="2"/>`;
  DIMENSIONS.forEach((d, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; const r = R * (scores[d.key] / 100); html += `<circle cx="${(cx + r * Math.cos(a)).toFixed(1)}" cy="${(cy + r * Math.sin(a)).toFixed(1)}" r="3" fill="#10b981"/>`; });
  svg.innerHTML = html;
}

function renderBarChart() {
  const userOverall = aggregateUserOverall();
  const svg = $('#bar-chart');
  const W = 700, padding = { left: 140, right: 60, top: 10, bottom: 10 }, barH = 22, rowH = 32;
  const chartW = W - padding.left - padding.right;
  const rows = [{ name: "Your LLM", score: userOverall, color: '#10b981', isUser: true }];
  Object.entries(state.benchmarks).forEach(([k, b]) => rows.push({ name: b.name, score: llmOverallScore(b), color: b.color }));
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
  if (state.benchmarkResults.length === 0) { container.innerHTML = '<div class="th-empty">No tests yet.</div>'; return; }
  const sorted = [...state.benchmarkResults].reverse();
  let html = '';
  sorted.forEach((r) => {
    const time = new Date(r.ts).toLocaleTimeString('en-US', { hour12: false });
    const prompt = r.prompt.length > 60 ? r.prompt.slice(0, 60) + '…' : r.prompt;
    html += `<div class="th-row"><span class="th-time">${time}</span><span class="th-prompt" title="${escapeHtml(r.prompt)}">${escapeHtml(prompt)}</span><span class="th-score">${r.analysis.overall}/100</span></div>`;
  });
  container.innerHTML = html;
}

// ===========================================================================
// Tab switching
// ===========================================================================
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}

// ===========================================================================
// Init
// ===========================================================================
async function init() {
  connectSocket();
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#rescan-btn').addEventListener('click', rescanLocalLlms);
  $('#clear-console-btn').addEventListener('click', () => { state.consoleLines = []; renderConsole(); });
  $('#chat-input').addEventListener('input', renderChatInput);
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); } });
  $('#chat-send-btn').addEventListener('click', sendMessage);
  $('#chat-stop-btn').addEventListener('click', stopChat);
  $('#clear-chat-btn').addEventListener('click', clearChat);
  $('#radar-compare-select').addEventListener('change', (e) => { state.radarCompareKey = e.target.value; renderRadarChart(); });
  $('#clear-benchmark-btn').addEventListener('click', () => { state.benchmarkResults = []; renderBenchmark(); log('Benchmark cleared.', 'info'); });

  // Fetch real device info + live LLM benchmark data + local LLM servers
  await fetchDeviceInfo();
  await fetchBenchmarks();
  await fetchLocalLlms();

  renderConnection();
  renderDeviceInfo();
  renderBenchmarkSource();
  renderLocalLlms();
  renderLlmServerBadge();
  renderConsole();
  renderChatMessages();
  renderChatInput();
  renderBenchmark();
}

document.addEventListener('DOMContentLoaded', init);
