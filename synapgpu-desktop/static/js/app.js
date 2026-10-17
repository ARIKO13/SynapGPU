/* SynapGPU Desktop — Frontend
 * Same UI as web version, but talks to real Python backend.
 * Real device specs via /api/device-info (psutil, nvidia-smi).
 * Real file upload via /api/files. Real LLM chat via /api/chat (Ollama/ZAI).
 * Real-time metrics via WebSocket from Flask-SocketIO.
 */
'use strict';

const state = {
  files: [],
  runState: 'idle',
  activeModel: null,
  runStartedAt: null,
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
  uptimeTimer: null,
  benchmarkResults: [],
  radarCompareKey: 'gpt4o',
  deviceInfo: null,
  benchmarks: {},
  benchmarkSource: '',
  localLlms: {},
  userModelParamsB: 0, // parameter count of user's model (in billions)
};

const MAX_HISTORY = 60;
const MAX_CONSOLE = 200;
const MAX_CHAT = 100;
const MAX_BENCHMARK = 50;

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function humanSize(b) {
  if (b < 1024) return `${b} B`;
  const u = ['KB','MB','GB','TB']; let v = b/1024, i = 0;
  while (v >= 1024 && i < u.length-1) { v/=1024; i++; }
  return `${v.toFixed(v>=100?0:1)} ${u[i]}`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function log(t, l='info') { state.consoleLines.push({id:uid(),ts:Date.now(),level:l,text:t}); if(state.consoleLines.length>MAX_CONSOLE) state.consoleLines.shift(); renderConsole(); }

// WebSocket
function connectSocket() {
  const s = io({transports:['websocket','polling'],reconnection:true,reconnectionAttempts:10,reconnectionDelay:1200,timeout:10000});
  s.on('connect', () => { state.connected=true; log('Connected to backend.','success'); renderConnection(); });
  s.on('disconnect', () => { state.connected=false; log('Backend disconnected.','warn'); renderConnection(); });
  s.on('metrics', (m) => {
    state.metrics = m; state.metricsHistory.push(m);
    if(state.metricsHistory.length>MAX_HISTORY) state.metricsHistory.shift();
    if(m.gpu&&m.gpu.available&&m.gpu.utilization!==undefined){state.gpuUtilHistory.push(m.gpu.utilization);if(state.gpuUtilHistory.length>MAX_HISTORY)state.gpuUtilHistory.shift();}
    state.ssdReadHistory.push(m.ssd.readMbps);
    if(state.ssdReadHistory.length>MAX_HISTORY) state.ssdReadHistory.shift();
    renderMetrics();
  });
  s.on('session:state', (ss) => {
    state.runState=ss.runState; state.activeModel=ss.activeModel; state.runStartedAt=ss.runStartedAt;
    if(ss.runState==='loading') log('Loading model…','info');
    else if(ss.runState==='running') log('Model ready.','success');
    else if(ss.runState==='stopped') log('Stopped.','warn');
    else if(ss.runState==='idle') log('Idle.','info');
    renderRunState();
  });
}

// API calls
async function fetchDeviceInfo() { try { const r=await fetch('/api/device-info'); if(r.ok){state.deviceInfo=await r.json(); renderDeviceInfo();} } catch(e){} }
async function fetchBenchmarks() { try { const r=await fetch('/api/benchmarks'); if(r.ok){const d=await r.json(); state.benchmarks=d.benchmarks||{}; state.benchmarkSource=d.source||''; log(`Loaded ${Object.keys(state.benchmarks).length} LLM benchmarks (${state.benchmarkSource}).`,'success'); renderBenchmark();} } catch(e){} }
async function fetchLocalLlms() { try { const r=await fetch('/api/local-llms'); if(r.ok){const d=await r.json(); state.localLlms=d.servers||{}; if(Object.keys(state.localLlms).length>0) log(`Local LLM: ${Object.keys(state.localLlms).join(', ')}`,'success');} } catch(e){} }
async function refreshFiles() { try { const r=await fetch('/api/files'); if(r.ok){const d=await r.json(); state.files=d.files||[]; renderFiles(); renderRunState();} } catch(e){} }

// File upload (real backend)
async function uploadFiles(fl) {
  const files=Array.from(fl); if(!files.length) return;
  log(`Uploading ${files.length} file${files.length>1?'s':''}…`,'info');
  try {
    const fd=new FormData(); files.forEach(f=>fd.append('files',f));
    const r=await fetch('/api/files',{method:'POST',body:fd});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const d=await r.json(); state.files=d.files;
    const tb=d.created.reduce((a,f)=>a+f.sizeBytes,0);
    log(`Uploaded ${d.created.length} file${d.created.length>1?'s':''} (${humanSize(tb)}).`,'success');
    renderFiles(); renderRunState(); renderCustomFileList();
  } catch(e) { log(`Upload failed: ${e.message}`,'error'); }
}
async function deleteFile(id) { try { const r=await fetch(`/api/files?id=${id}`,{method:'DELETE'}); if(r.ok){state.files=state.files.filter(f=>f.id!==id); log('File deleted.','info'); renderFiles(); renderRunState(); renderCustomFileList();} } catch(e){} }
async function clearAllFiles() { for(const f of state.files){try{await fetch(`/api/files?id=${f.id}`,{method:'DELETE'});}catch(e){}} state.files=[]; log('All files cleared.','info'); renderFiles(); renderRunState(); renderCustomFileList(); }

// Run control
async function handleRun() {
  const llm=state.files.find(f=>f.category==='llm'); const model=llm?llm.name:null;
  log(`Run: ${model??'(no model)'}`,'info');
  try { await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'start',model})}); } catch(e){}
  state.runState='loading'; state.activeModel=model; state.runStartedAt=Date.now(); renderRunState();
}
async function handleStop() {
  log('Stop.','warn');
  try { await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'stop'})}); } catch(e){}
  state.runState='stopped'; renderRunState();
}

// Chat — real backend (Ollama/llama.cpp/ZAI)
const SYSTEM_PROMPT="You are a helpful AI assistant. Answer clearly and concisely.";
async function sendMessage() {
  const input=$('#chat-input'); const text=input.value.trim();
  if(!text||state.runState!=='running'||state.chatStreaming) return;
  const um={id:uid(),role:'user',content:text,ts:Date.now()};
  const aid=uid(); const am={id:aid,role:'assistant',content:'',ts:Date.now(),streaming:true};
  state.chatMessages.push(um,am); if(state.chatMessages.length>MAX_CHAT) state.chatMessages=state.chatMessages.slice(-MAX_CHAT);
  input.value=''; $('#chat-error').classList.add('hidden'); state.chatStreaming=true;
  renderChatMessages(); renderChatInput();
  const startedAt=Date.now();
  const ctrl=new AbortController(); state.chatAbortController=ctrl;
  try {
    const history=state.chatMessages.filter(m=>m.id!==aid&&m.role!=='system').map(m=>({role:m.role,content:m.content}));
    const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'system',content:SYSTEM_PROMPT},...history]}),signal:ctrl.signal});
    if(!r.ok||!r.body){const et=await r.text();throw new Error(et||`HTTP ${r.status}`);}
    const reader=r.body.getReader(); const dec=new TextDecoder(); let buf='';
    while(true){const{done,value}=await reader.read();if(done)break;
      buf+=dec.decode(value,{stream:true}); const lines=buf.split('\n'); buf=lines.pop()??'';
      for(const line of lines){if(!line.trim())continue;try{const e=JSON.parse(line);
        if(e.type==='token'){const m=state.chatMessages.find(m=>m.id===aid);if(m)m.content+=e.content;renderChatMessages();}
        else if(e.type==='done'){const m=state.chatMessages.find(m=>m.id===aid);if(m){m.streaming=false;m.latencyMs=e.latencyMs;}
          const a=analyzeResponse(text,m?m.content:'',e.latencyMs||0);
          state.benchmarkResults.push({id:uid(),prompt:text,response:m?m.content:'',analysis:a,ts:Date.now()});
          if(state.benchmarkResults.length>MAX_BENCHMARK) state.benchmarkResults=state.benchmarkResults.slice(-MAX_BENCHMARK);
          renderBenchmark(); log(`Scored ${a.overall}/100`,'info');}
        else if(e.type==='error'){$('#chat-error').textContent=e.message;$('#chat-error').classList.remove('hidden');const m=state.chatMessages.find(m=>m.id===aid);if(m)m.streaming=false;}
      }catch{}}
    }
  } catch(e) {
    if(e.name==='AbortError') log('Chat aborted.','warn');
    else {$('#chat-error').textContent=e.message;$('#chat-error').classList.remove('hidden');log(`Chat error: ${e.message}`,'error');}
    const m=state.chatMessages.find(m=>m.id===aid); if(m) m.streaming=false;
  } finally { state.chatStreaming=false; state.chatAbortController=null; renderChatInput(); renderChatMessages(); }
}
function stopChat() { if(state.chatAbortController) state.chatAbortController.abort(); }
function clearChat() { state.chatMessages=[]; renderChatMessages(); }

// WebGPU model loader (same as web version)
let activeModelId=null,llmMode='pretrained';
let trainedModel=null; // {name, size, params, base, dataset, epochs, fileId, path}

// --- Test tab: populate model dropdowns ---
function populateModelSelects(){
  const sel=$('#pretrained-model-select');if(!sel)return;
  const llmFiles=state.files.filter(f=>f.category==='llm');
  let opts='<option value="">Select .gguf from Models ↑</option>';
  llmFiles.forEach(f=>{opts+=`<option value="${f.id}">${escapeHtml(f.name)} (${f.humanSize})</option>`;});
  sel.innerHTML=opts;
  const btn=$('#load-pretrained-btn');if(btn)btn.disabled=!llmFiles.length;
  // Update train tab selects too
  const tms=$('#train-model-select');if(tms){tms.innerHTML='<option value="">Select from Models ↑</option>'+llmFiles.map(f=>`<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');}
  const tds=$('#train-dataset-select');if(tds){const ds=state.files.filter(f=>['dataset','notebook'].includes(f.category));tds.innerHTML='<option value="">Select from Datasets ↑</option>'+ds.map(f=>`<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');}
  // Enable Start Training button if both selected
  updateTrainButton();
}

function updateTrainButton(){
  const ms=$('#train-model-select'),ds=$('#train-dataset-select'),btn=$('#start-train-btn');
  if(!btn)return;
  btn.disabled=!(ms&&ms.value&&ds&&ds.value);
}

// --- Load pre-trained model for testing ---
async function handleLoadPretrained(){
  const sel=$('#pretrained-model-select');if(!sel||!sel.value)return;
  const file=state.files.find(f=>f.id===sel.value);if(!file)return;
  state.runState='loading';state.activeModel=file.name;renderRunState();
  try{
    // Tell backend to load this model for chat
    const r=await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'start',model:file.name})});
    if(!r.ok)throw new Error('Backend failed to load model');
    state.runState='running';activeModelId=file.name;
    log('Model loaded: '+file.name,'success');
    onModelReady(file.name);
  }catch(e){log('Load failed: '+e.message,'error');state.runState='error';renderRunState();}
}

// --- Load trained model for testing ---
async function handleLoadTrained(){
  if(!trainedModel)return;
  state.runState='loading';state.activeModel=trainedModel.name;renderRunState();
  try{
    const r=await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'start',model:trainedModel.name})});
    if(!r.ok)throw new Error('Backend failed to load trained model');
    state.runState='running';activeModelId=trainedModel.name;
    state.userModelParamsB=trainedModel.params||0;
    log('Trained model loaded: '+trainedModel.name+' ('+trainedModel.params+'B params)','success');
    onModelReady(trainedModel.name);
  }catch(e){log('Load failed: '+e.message,'error');state.runState='error';renderRunState();}
}

// --- Start training ---
async function handleStartTrain(){
  const ms=$('#train-model-select'),ds=$('#train-dataset-select');if(!ms||!ms.value||!ds||!ds.value)return;
  const params={
    modelId:ms.value,
    datasetId:ds.value,
    epochs:parseInt($('#train-epochs')?.value||'3'),
    lr:$('#train-lr')?.value||'1e-4',
    batch:parseInt($('#train-batch')?.value||'4'),
    ctx:parseInt($('#train-ctx')?.value||'2048'),
    method:$('#train-method')?.value||'lora',
    output:$('#train-output')?.value||'trained-model',
  };
  log('Starting training: '+params.method+' on '+params.modelId+' with '+params.datasetId,'info');
  $('#start-train-btn')?.classList.add('hidden');
  $('#stop-train-btn')?.classList.remove('hidden');
  const tp=$('#train-progress');if(tp)tp.classList.remove('hidden');
  $('#tp-status').textContent='Running';
  $('#tp-epoch').textContent='0/'+params.epochs;
  $('#tp-loss').textContent='—';
  $('#tp-params').textContent='—';
  $('#tp-iter').textContent='0';
  $('#tp-speed').textContent='—';
  $('#tp-eta').textContent='—';
  $('#tp-bar').style.width='0%';
  $('#tp-log').innerHTML='';

  try{
    const r=await fetch('/api/train',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'Training failed');
    // Training completed (backend does it synchronously for now)
    trainedModel={
      name:data.name||params.output+'.gguf',
      size:data.size||0,
      params:data.params_b||0,
      base:state.files.find(f=>f.id===params.modelId)?.name||'?',
      dataset:state.files.find(f=>f.id===params.datasetId)?.name||'?',
      epochs:params.epochs,
      fileId:data.fileId||'',
      path:data.path||'',
    };
    $('#tp-status').textContent='Done';
    $('#tp-bar').style.width='100%';
    $('#tp-epoch').textContent=params.epochs+'/'+params.epochs;
    $('#tp-params').textContent=trainedModel.params+'B';
    $('#tp-log').innerHTML+='<br>Training complete. Model: '+trainedModel.name+' ('+trainedModel.params+'B params)';
    log('Training complete: '+trainedModel.name+' ('+trainedModel.params+'B params)','success');
    // Show trained model in Test tab
    showTrainedModel();
    // Add to file list
    if(data.fileId){await refreshFiles();populateModelSelects();}
  }catch(e){
    $('#tp-status').textContent='Error';
    $('#tp-log').innerHTML+='<br>Error: '+e.message;
    log('Training error: '+e.message,'error');
  }finally{
    $('#start-train-btn')?.classList.remove('hidden');
    $('#stop-train-btn')?.classList.add('hidden');
  }
}

function showTrainedModel(){
  if(!trainedModel)return;
  $('#trained-model-area')?.classList.add('hidden');
  const ti=$('#trained-model-info');if(!ti)return;
  ti.classList.remove('hidden');
  $('#ti-name').textContent=trainedModel.name;
  $('#ti-size').textContent=trainedModel.size>0?humanSize(trainedModel.size):'—';
  $('#ti-params').textContent=trainedModel.params>0?trainedModel.params+'B':'—';
  $('#ti-base').textContent=trainedModel.base;
  $('#ti-dataset').textContent=trainedModel.dataset;
  $('#ti-epochs').textContent=trainedModel.epochs;
  if(trainedModel.fileId){
    const dl=$('#download-trained-btn');if(dl)dl.href='/api/files/'+trainedModel.fileId+'/download';
  }
}

// --- Tab switching for Test (pretrained vs trained) ---
function setLlmMode(mode){llmMode=mode;$$('.llm-tab').forEach(t=>t.classList.toggle('active',t.dataset.mode===mode));$('#llm-pretrained')?.classList.toggle('hidden',mode!=='pretrained');$('#llm-trained')?.classList.toggle('hidden',mode!=='trained');}

function onModelReady(mid){
  const pe=$('#load-progress');if(pe){$('#lp-text').textContent='Ready';$('#lp-percent').textContent='100%';$('#lp-bar').style.width='100%';setTimeout(()=>{pe.classList.add('hidden');},1500);}
  const inp=$('#chat-input');if(inp){inp.disabled=false;inp.placeholder='Type a message… (Cmd/Ctrl+Enter)';inp.focus();}
  const b=$('#chat-model-badge');if(b){b.textContent=mid;b.classList.remove('hidden');}
  state.runState='running';state.activeModel=mid;renderRunState();
}

// Benchmark analyzer
const BENCHMARKS_FALLBACK={
  gpt4o:{name:"GPT-4o",color:"#10a37f",mmlu:88.7,humaneval:90.2,gsm8k:95.8,math:76.6,reasoning:93,speed_tps:80,params_b:200},
  claude35:{name:"Claude 3.5 Sonnet",color:"#d97706",mmlu:88.7,humaneval:92.0,gsm8k:96.4,math:71.1,reasoning:95,speed_tps:80,params_b:175},
  llama3_405b:{name:"Llama 3.1 405B",color:"#0866ff",mmlu:87.3,humaneval:89.0,gsm8k:96.8,math:73.8,reasoning:91,speed_tps:20,params_b:405},
  llama3_70b:{name:"Llama 3.1 70B",color:"#0866ff",mmlu:82.0,humaneval:80.0,gsm8k:84.5,math:50.0,reasoning:85,speed_tps:100,params_b:70},
  llama3_8b:{name:"Llama 3.1 8B",color:"#7c3aed",mmlu:66.0,humaneval:72.0,gsm8k:84.0,math:30.0,reasoning:65,speed_tps:150,params_b:8},
  mistral_large:{name:"Mistral Large 2",color:"#ff6b35",mmlu:84.0,humaneval:81.0,gsm8k:81.0,math:45.0,reasoning:82,speed_tps:60,params_b:123},
  gemini15_pro:{name:"Gemini 1.5 Pro",color:"#4285f4",mmlu:85.9,humaneval:84.1,gsm8k:91.7,math:67.7,reasoning:91,speed_tps:50,params_b:175},
  gemini_flash:{name:"Gemini 1.5 Flash",color:"#4285f4",mmlu:78.9,humaneval:71.5,gsm8k:80.5,math:53.0,reasoning:84,speed_tps:200,params_b:8},
  qwen2_72b:{name:"Qwen2.5 72B",color:"#06b6d4",mmlu:84.0,humaneval:86.0,gsm8k:89.0,math:50.0,reasoning:84,speed_tps:90,params_b:72},
  qwen2_7b:{name:"Qwen2.5 7B",color:"#06b6d4",mmlu:72.0,humaneval:75.0,gsm8k:85.0,math:35.0,reasoning:70,speed_tps:130,params_b:7},
  phi3_medium:{name:"Phi-3 Medium",color:"#ec4899",mmlu:78.0,humaneval:62.0,gsm8k:91.0,math:45.0,reasoning:75,speed_tps:120,params_b:14},
  deepseek_v2:{name:"DeepSeek-V2",color:"#4f46e5",mmlu:78.5,humaneval:81.1,gsm8k:92.2,math:53.7,reasoning:80,speed_tps:60,params_b:236},
  smollm2_360m:{name:"SmolLM2 360M",color:"#84cc16",mmlu:25.0,humaneval:15.0,gsm8k:10.0,math:5.0,reasoning:20,speed_tps:300,params_b:0.36},
  smollm2_1b:{name:"SmolLM2 1.7B",color:"#84cc16",mmlu:35.0,humaneval:25.0,gsm8k:20.0,math:10.0,reasoning:30,speed_tps:250,params_b:1.7},
};
const DIMENSIONS=[
  {key:'reasoning',label:'Reasoning',hint:'Logical & multi-step thinking'},
  {key:'code',label:'Code',hint:'Code blocks & function defs'},
  {key:'math',label:'Math',hint:'Numbers, formulas, equations'},
  {key:'knowledge',label:'Knowledge',hint:'Depth & richness of content'},
  {key:'speed',label:'Speed',hint:'Throughput (tokens/sec)'},
  {key:'coherence',label:'Coherence',hint:'Sentence structure sanity'},
];
function analyzeResponse(u,a,lat){const rl=a.length,pw=Math.max(1,u.trim().split(/\s+/).length),rw=Math.max(1,a.trim().split(/\s+/).length),rt=Math.max(1,Math.round(rl/4)),tps=lat>0?(rt/lat)*1000:0;const cb=(a.match(/```[\s\S]*?```/g)||[]).length,ic=(a.match(/`[^`\n]+`/g)||[]).length,hf=/\b(def |function |class |return |import )/.test(a),cl=(a.match(/^\s*(if |for |while |return |def |class |import |const )/gm)||[]).length,hm=/[∑∫π√≠≤≥±×÷∞²]/.test(a),hn=/\d/.test(a),he=/[^=!<>]=[^\s=]/.test(a),rw2=(a.toLowerCase().match(/\b(therefore|because|thus|hence|first|second|however|moreover|step|reason)\b/g)||[]).length,sc=(a.match(/[.!?\n]+/g)||[]).length,as=sc>0?rw/sc:rw,rd=rw/pw,rd2=rw2/Math.max(1,rw);const rs=Math.min(100,Math.round(rd2*250+(sc>3?25:sc*8)+(rw>50?15:0)+(rw>150?10:0)));const cs=Math.min(100,Math.round(cb*30+Math.min(20,cl*4)+(hf?20:0)+Math.min(10,ic*2)));const ms=Math.min(100,Math.round((hm?35:0)+(hn?25:0)+(he?20:0)+20));const ks=Math.min(100,Math.round(Math.min(35,rw/4)+Math.min(25,rl/60)+Math.min(20,as)+Math.min(20,rd*5)));const ss=Math.min(100,Math.round(tps));const co=a.length>50&&sc>=1&&as<30;const cos=Math.min(100,Math.round((co?35:0)+(rw>30?20:0)+(sc>2?20:sc*7)+(as>5&&as<25?25:10)));const scores={reasoning:rs,code:cs,math:ms,knowledge:ks,speed:ss,coherence:cos};const overall=Math.round((rs+cs+ms+ks+ss+cos)/6);return{responseLen:rl,responseWords:rw,latencyMs:lat,tps:Math.round(tps*10)/10,scores,overall,timestamp:Date.now()};}
function llmB2D(b){if(!b)return null;return{reasoning:b.reasoning||70,code:b.humaneval||0,math:Math.round(((b.gsm8k||0)+(b.math||0))/2),knowledge:b.mmlu||0,speed:Math.min(100,b.speed_tps||0),coherence:Math.round(((b.mmlu||0)+(b.reasoning||70))/2)};}
function llmOS(b){if(!b)return 0;const d=llmB2D(b);return Math.round((d.reasoning+d.code+d.math+d.knowledge+d.speed+d.coherence)/6);}
function aggScores(){if(!state.benchmarkResults.length)return null;const s={reasoning:0,code:0,math:0,knowledge:0,speed:0,coherence:0};state.benchmarkResults.forEach(r=>Object.keys(s).forEach(k=>s[k]+=r.analysis.scores[k]));const n=state.benchmarkResults.length;Object.keys(s).forEach(k=>s[k]=Math.round(s[k]/n));return s;}
function aggOverall(){if(!state.benchmarkResults.length)return 0;const s=aggScores();return Math.round((s.reasoning+s.code+s.math+s.knowledge+s.speed+s.coherence)/6);}
function computeVerdict(){const u=aggOverall();if(!u)return null;const b=Object.keys(state.benchmarks).length?state.benchmarks:BENCHMARKS_FALLBACK;
// Filter LLMs by parameter count if user model params known
const userParams=state.userModelParamsB||0;
let filtered=b;
if(userParams>0){
const range=userParams*3; // within 3x of user's params
filtered=Object.fromEntries(Object.entries(b).filter(([k,v])=>{
const p=v.params_b||0;return p>0&&p<=range&&p>=userParams/3;}));
// If too few in range, expand to 10x
if(Object.keys(filtered).length<3){filtered=Object.fromEntries(Object.entries(b).filter(([k,v])=>{const p=v.params_b||0;return p>0&&p<=userParams*10;}));}
log('Benchmark filter: user model '+userParams+'B params → comparing with '+Object.keys(filtered).length+' LLMs in similar range','info');
}
const comps=Object.entries(filtered).map(([k,v])=>{const o=llmOS(v);return{key:k,name:v.name+(v.params_b?' ('+v.params_b+'B)':''),color:v.color,overall:o,diff:u-o,source:v.source||'',params:v.params_b||0};});comps.sort((a,b)=>b.overall-a.overall);const closest=comps.reduce((b,c)=>!b||Math.abs(c.diff)<Math.abs(b.diff)?c:b,null);return{userOverall:u,comparisons:comps,closest,beats:comps.filter(c=>c.diff>0).sort((a,b)=>a.diff-b.diff),losesTo:comps.filter(c=>c.diff<0).sort((a,b)=>b.diff-a.diff)};}

// Rendering — same as web version
function statusAccent(p){return p>=90?'rose':p>=70?'amber':'emerald';}
function applyAccentClass(c,p){c.setAttribute('data-accent',statusAccent(p));}
function renderConnection(){const cs=$('#conn-status'),ft=$('#footer-conn');if(state.connected){cs.classList.add('online');$('#conn-text').textContent='live';ft.classList.add('online');ft.innerHTML='<span class="indicator-dot"></span> live';}else{cs.classList.remove('online');$('#conn-text').textContent='offline';ft.classList.remove('online');ft.innerHTML='<span class="indicator-dot"></span> offline';}if(state.connected||state.metrics){$('#dashboard-loading').classList.add('hidden');$('#dashboard-content').classList.remove('hidden');}else{$('#dashboard-loading').classList.remove('hidden');$('#dashboard-content').classList.add('hidden');}}
function renderDeviceInfo(){const i=state.deviceInfo;if(!i)return;$('#di-hostname').textContent=`${i.platform||''} ${i.machine||''}`.trim()||i.cpu.model;$('#di-cpu').textContent=i.cpu.model;$('#di-cpu').title=i.cpu.model;$('#di-cores').textContent=`${i.cpu.coresPhysical}P / ${i.cpu.coresLogical}L`;$('#cpu-cores-footer').textContent=`${i.cpu.coresLogical} logical cores`;$('#di-ram').textContent=`${i.ram.totalGb} GB`;$('#ram-total').textContent=i.ram.totalGb;$('#di-disk').textContent=`${i.disk.totalGb} GB`;$('#ssd-total').textContent=i.disk.totalGb;const ga=$('#gpu-unavailable'),gm=$('#gpu-metrics-grid'),gc=$('#gpu-chart-card');if(i.gpu.available){$('#di-gpu').textContent=i.gpu.name;$('#di-gpu').classList.add('accent');$('#di-vram').textContent=`${i.gpu.vramTotalGb} GB`;$('#di-vram').classList.add('accent');$('#gpu-vram-total').textContent=i.gpu.vramTotalGb.toFixed(0);ga?.classList.add('hidden');gm?.classList.remove('hidden');gc?.classList.remove('hidden');}else{$('#di-gpu').textContent='Not detected';$('#di-gpu').classList.add('muted');$('#di-vram').textContent='—';$('#di-vram').classList.add('muted');ga?.classList.remove('hidden');gm?.classList.add('hidden');gc?.classList.add('hidden');}renderMultiGPU();renderMultiDisk();}

function renderMultiGPU(){const i=state.deviceInfo;if(!i||!i.gpus)return;const section=$('#multi-gpu-section');if(!section)return;const gpus=i.gpus.filter(g=>g.available);if(gpus.length<=1){section.classList.add('hidden');return;}section.classList.remove('hidden');$('#gpu-count-badge').textContent=gpus.length;const list=$('#multi-gpu-list');let h='';gpus.forEach(g=>{const tag=g.type==='integrated'?'integrated':'dedicated';h+=`<div class="mds-row"><span class="mds-row-label">${escapeHtml(g.name)}</span><span class="mds-row-tag ${tag}">${g.type||'dedicated'}</span><span class="mds-row-value">${g.vramTotalGb} GB VRAM</span><span class="mds-row-value">${g.backend||'?'}</span></div>`;});list.innerHTML=h;}

function renderMultiDisk(){const i=state.deviceInfo;if(!i||!i.disk||!i.disk.partitions)return;const section=$('#multi-disk-section');if(!section)return;const parts=i.disk.partitions;if(parts.length<=1){section.classList.add('hidden');return;}section.classList.remove('hidden');$('#disk-count-badge').textContent=parts.length;const list=$('#multi-disk-list');let h='';parts.forEach(p=>{const pct=p.percent||0;const barCls=pct>=90?'bad':pct>=70?'warn':'';h+=`<div class="mds-row"><span class="mds-row-label">${escapeHtml(p.device||p.mountpoint||'disk')}</span><span class="mds-row-value">${p.usedGb}/${p.totalGb} GB</span><span class="mds-row-value">${pct.toFixed(0)}%</span><span class="mds-row-bar"><span class="mds-row-bar-fill ${barCls}" style="width:${pct}%"></span></span></div>`;});list.innerHTML=h;}

function renderMetricsLiveMultiGPU(){const m=state.metrics;if(!m||!m.gpus)return;const list=$('#multi-gpu-list');if(!list)return;const gpus=m.gpus.filter(g=>g.available);if(gpus.length<=1)return;let h='';gpus.forEach(g=>{const tag=g.type==='integrated'?'integrated':'dedicated';const util=g.utilization||0;const memPct=g.memoryTotalGb>0?(g.memoryUsedGb/g.memoryTotalGb*100):0;const barCls=util>=90?'bad':util>=70?'warn':'';h+=`<div class="mds-row"><span class="mds-row-label">${escapeHtml(g.name)}</span><span class="mds-row-tag ${tag}">${g.type||'dedicated'}</span><span class="mds-row-value">${util.toFixed(0)}% · ${g.memoryUsedGb.toFixed(1)}/${g.memoryTotalGb.toFixed(0)}GB</span><span class="mds-row-value">${g.tempC?.toFixed(0)||'?'}°C · ${g.powerW?.toFixed(0)||'?'}W</span><span class="mds-row-bar"><span class="mds-row-bar-fill ${barCls}" style="width:${util}%"></span></span></div>`;});list.innerHTML=h;}

function renderMetricsLiveMultiDisk(){const m=state.metrics;if(!m||!m.ssd||!m.ssd.partitions)return;const list=$('#multi-disk-list');if(!list)return;const parts=m.ssd.partitions;if(parts.length<=1)return;let h='';parts.forEach(p=>{const pct=p.percent||0;const barCls=pct>=90?'bad':pct>=70?'warn':'';h+=`<div class="mds-row"><span class="mds-row-label">${escapeHtml(p.device||p.mountpoint||'disk')}</span><span class="mds-row-value">${p.usedGb}/${p.totalGb} GB</span><span class="mds-row-value">${pct.toFixed(0)}%</span><span class="mds-row-bar"><span class="mds-row-bar-fill ${barCls}" style="width:${pct}%"></span></span></div>`;});list.innerHTML=h;}
function renderMetrics(){if(!state.metrics)return;const m=state.metrics;$('#status-time').textContent=new Date(m.ts).toLocaleTimeString('en-US',{hour12:false});const cu=m.cpu?.utilization??0;state.cpuUtilHistory.push(cu);if(state.cpuUtilHistory.length>MAX_HISTORY)state.cpuUtilHistory.shift();$('#cpu-util').textContent=cu.toFixed(1);$('#cpu-util-bar').style.width=`${cu}%`;const cc=$('#cpu-metrics-grid .metric-card');if(cc)applyAccentClass(cc,cu);
if(m.gpu.available&&m.gpu.utilization!==undefined){const gu=m.gpu.utilization;$('#gpu-util').textContent=gu.toFixed(1);$('#gpu-util-bar').style.width=`${gu}%`;$('#gpu-vram').textContent=m.gpu.memoryUsedGb.toFixed(1);$('#gpu-vram-total').textContent=m.gpu.memoryTotalGb.toFixed(0);const gmp=(m.gpu.memoryUsedGb/m.gpu.memoryTotalGb)*100;$('#gpu-mem').textContent=gmp.toFixed(1);$('#gpu-mem-bar').style.width=`${gmp}%`;$('#gpu-temp-wrap').textContent=`${m.gpu.tempC.toFixed(0)}°C`;$('#gpu-power-wrap').textContent=`${m.gpu.powerW.toFixed(0)} W`;const gcs=$$('#gpu-metrics-grid .metric-card');if(gcs[0])applyAccentClass(gcs[0],gu);if(gcs[1])applyAccentClass(gcs[1],gmp);state.gpuUtilHistory.push(gu);if(state.gpuUtilHistory.length>MAX_HISTORY)state.gpuUtilHistory.shift();const avg=state.gpuUtilHistory.length?state.gpuUtilHistory.reduce((a,b)=>a+b,0)/state.gpuUtilHistory.length:0;$('#gpu-avg').textContent=avg.toFixed(1);drawLineChart('#gpu-chart',state.gpuUtilHistory,'#10b981',100);}
const rp=(m.ram.usedGb/m.ram.totalGb)*100;$('#ram-pct').textContent=rp.toFixed(0);$('#ram-used').textContent=m.ram.usedGb.toFixed(2);$('#ram-total').textContent=m.ram.totalGb;$('#ram-bar').style.width=`${rp}%`;
const sp=(m.ssd.usedGb/m.ssd.totalGb)*100;$('#ssd-pct').textContent=sp.toFixed(1);$('#ssd-used').textContent=m.ssd.usedGb.toFixed(0);$('#ssd-total').textContent=m.ssd.totalGb;$('#ssd-bar').style.width=`${sp}%`;$('#ssd-read').textContent=m.ssd.readMbps.toFixed(0);$('#ssd-write').textContent=m.ssd.writeMbps.toFixed(0);$('#ssd-read-2').textContent=m.ssd.readMbps.toFixed(0);$('#ssd-write-2').textContent=m.ssd.writeMbps.toFixed(0);
$('#net-rx').textContent=m.net.rxMbps.toFixed(1);$('#net-tx').textContent=m.net.txMbps.toFixed(1);
$('#footer-gpu').textContent=m.gpu.available?(m.gpu.utilization??0).toFixed(0):'—';$('#footer-ram').textContent=rp.toFixed(0);$('#footer-ssd').textContent=sp.toFixed(0);$('#footer-files').textContent=state.files.length;
renderMetricsLiveMultiGPU();renderMetricsLiveMultiDisk();
drawSparkline('#ram-spark',state.metricsHistory.map(x=>(x.ram.usedGb/x.ram.totalGb)*100),'#06b6d4');drawLineChart('#ssd-chart',state.ssdReadHistory,'#f59e0b',1000);}
function drawSparkline(s,d,c){const v=$(s);if(!v)return;v.innerHTML='';if(d.length<2)return;const W=200,H=40,mx=Math.max(...d,1),mn=Math.min(...d,0),r=mx-mn||1;const p=d.map((v,i)=>`${((i/(d.length-1))*W).toFixed(1)},${(H-((v-mn)/r)*H).toFixed(1)}`).join(' ');const el=document.createElementNS('http://www.w3.org/2000/svg','polyline');el.setAttribute('points',p);el.setAttribute('fill','none');el.setAttribute('stroke',c);el.setAttribute('stroke-width','1.5');el.setAttribute('vector-effect','non-scaling-stroke');v.appendChild(el);}
function drawLineChart(s,d,c,mY){const v=$(s);if(!v)return;v.innerHTML='';if(d.length<2)return;const vb=v.getAttribute('viewBox').split(' ').map(Number),W=vb[2],H=vb[3],mx=Math.max(...d,1,mY?mY*0.1:0),r=mx||1;const p=d.map((v,i)=>`${((i/(d.length-1))*W).toFixed(1)},${(H-(v/r)*H).toFixed(1)}`).join(' ');const poly=document.createElementNS('http://www.w3.org/2000/svg','polygon');poly.setAttribute('points',`0,${H} ${p} ${W},${H}`);poly.setAttribute('fill',c);poly.setAttribute('fill-opacity','0.15');v.appendChild(poly);const ln=document.createElementNS('http://www.w3.org/2000/svg','polyline');ln.setAttribute('points',p);ln.setAttribute('fill','none');ln.setAttribute('stroke',c);ln.setAttribute('stroke-width','1.5');ln.setAttribute('vector-effect','non-scaling-stroke');v.appendChild(ln);}
function renderRunState(){const rb=$('#run-btn'),sb=$('#stop-btn');const lf=state.files.find(f=>f.category==='llm');const canRun=!!lf&&['idle','stopped','error'].includes(state.runState);if(['running','loading'].includes(state.runState)){rb.classList.add('hidden');sb.classList.remove('hidden');sb.querySelector('span').textContent=state.runState==='loading'?'Loading…':'Stop';}else{rb.classList.remove('hidden');sb.classList.add('hidden');rb.disabled=!canRun;}const d=$('#status-dot'),t=$('#status-text');d.className='status-dot';if(state.runState==='running'){d.classList.add('running');t.textContent='Model active';}else if(state.runState==='loading'){d.classList.add('loading');t.textContent='Loading model…';}else if(state.runState==='error'){d.classList.add('error');t.textContent='Error';}else if(state.runState==='stopped'){t.textContent='Stopped';}else{t.textContent='System idle';}const b=$('#model-badge');if(state.activeModel&&['running','loading'].includes(state.runState)){b.classList.remove('hidden');$('#active-model').textContent=state.activeModel;startUptime();}else{b.classList.add('hidden');stopUptime();}$('#footer-run').textContent=state.runState;const p=$('#chat-tab-pulse');if(state.runState==='running')p?.classList.remove('hidden');else p?.classList.add('hidden');const cb=$('#chat-model-badge');if(state.activeModel&&state.runState==='running'){cb.textContent=state.activeModel;cb.classList.remove('hidden');}else{cb?.classList.add('hidden');}renderChatInput();}
function startUptime(){if(state.uptimeTimer||!state.runStartedAt)return;const t=()=>{if(!state.runStartedAt)return;const s=Math.floor((Date.now()-state.runStartedAt)/1000);$('#uptime').textContent=`${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};t();state.uptimeTimer=setInterval(t,1000);}
function stopUptime(){if(state.uptimeTimer){clearInterval(state.uptimeTimer);state.uptimeTimer=null;}}
function renderFiles(){
  // Split files into models and datasets
  const models=state.files.filter(f=>['llm','config','other'].includes(f.category));
  const datasets=state.files.filter(f=>['dataset','notebook'].includes(f.category));

  // Render models list
  const ml=$('#model-list');
  if(ml){
    if(!models.length){ml.innerHTML='<div class="empty-state"><p>No models yet</p></div>';}
    else{let h='';models.forEach(f=>{const t=new Date(f.uploadedAt).toLocaleTimeString('en-US',{hour12:false});
      h+=`<div class="file-row"><span class="file-icon ${f.category}"></span><div class="file-info"><div class="file-name">${escapeHtml(f.name)}</div><div class="file-meta">${f.humanSize} · ${t}</div></div><button class="file-delete" data-id="${f.id}" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div>`;});
    ml.innerHTML=h;ml.querySelectorAll('.file-delete').forEach(b=>b.addEventListener('click',()=>deleteFile(b.dataset.id)));}
  }

  // Render datasets list
  const dl=$('#dataset-list');
  if(dl){
    if(!datasets.length){dl.innerHTML='<div class="empty-state"><p>No datasets yet</p></div>';}
    else{let h='';datasets.forEach(f=>{const t=new Date(f.uploadedAt).toLocaleTimeString('en-US',{hour12:false});
      h+=`<div class="file-row"><span class="file-icon ${f.category}"></span><div class="file-info"><div class="file-name">${escapeHtml(f.name)}</div><div class="file-meta">${f.humanSize} · ${t}</div></div><button class="file-delete" data-id="${f.id}" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div>`;});
    dl.innerHTML=h;dl.querySelectorAll('.file-delete').forEach(b=>b.addEventListener('click',()=>deleteFile(b.dataset.id)));}
  }

  // Update clear buttons
  const cbm=$('#clear-models-btn');if(cbm)cbm.classList.toggle('hidden',!models.length);
  const cbd=$('#clear-datasets-btn');if(cbd)cbd.classList.toggle('hidden',!datasets.length);
  // Update footer
  const ff=$('#footer-files');if(ff)ff.textContent=state.files.length;
}
function renderConsole(){const o=$('#console-output');$('#console-count').textContent=`${state.consoleLines.length} lines`;if(!state.consoleLines.length){o.innerHTML='<div class="console-empty">No output yet.</div>';return;}const I={info:'ℹ',warn:'⚠',error:'✗',success:'✓'};let h='';state.consoleLines.forEach(l=>{const ts=new Date(l.ts).toLocaleTimeString('en-US',{hour12:false});h+=`<div class="console-line ${l.level}"><span class="ts">${ts}</span><span class="level">${I[l.level]||'ℹ'}</span><span class="text">${escapeHtml(l.text)}</span></div>`;});o.innerHTML=h;o.scrollTop=o.scrollHeight;}
function renderChatMessages(){const c=$('#chat-messages');if(!state.chatMessages.length){const sub=state.runState!=='running'?'Click Run to load model first.':'Type a message and press Cmd/Ctrl+Enter.';c.innerHTML=`<div class="chat-empty"><p class="ce-sub">${sub}</p></div>`;return;}const UA='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';const AA='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg>';let h='';state.chatMessages.forEach(m=>{const iu=m.role==='user';let c2=escapeHtml(m.content);if(m.streaming&&!m.content)c2='<span class="chat-thinking">thinking…</span>';else if(m.streaming)c2+='<span class="chat-cursor"></span>';const meta=m.latencyMs?`<div class="chat-meta">${(m.latencyMs/1000).toFixed(2)}s</div>`:'';h+=`<div class="chat-message ${m.role}"><div class="chat-avatar ${m.role}">${iu?UA:AA}</div><div class="chat-bubble-wrap"><div class="chat-bubble">${c2}</div>${meta}</div></div>`;});c.innerHTML=h;c.scrollTop=c.scrollHeight;}
function renderChatInput(){const i=$('#chat-input'),s=$('#chat-send-btn'),b=$('#chat-stop-btn');if(state.runState==='running'||webllmEngine||wllamaInstance){i.disabled=false;i.placeholder='Type a message… (Cmd/Ctrl+Enter)';}else{i.disabled=true;i.placeholder='Run model first…';}if(state.chatStreaming){s.classList.add('hidden');b.classList.remove('hidden');}else{s.classList.remove('hidden');b.classList.add('hidden');s.disabled=!(state.runState==='running'||webllmEngine||wllamaInstance)||!i.value.trim();}}
function renderBenchmark(){const e=$('#benchmark-empty'),c=$('#benchmark-content'),p=$('#benchmark-tab-pulse');if(!state.benchmarkResults.length){e.classList.remove('hidden');c.classList.add('hidden');p.classList.add('hidden');return;}e.classList.add('hidden');c.classList.remove('hidden');p.classList.remove('hidden');renderVerdict();renderDimScores();renderRadarChart();renderBarChart();renderTestHistory();renderCompareSelect();}
function renderVerdict(){const v=computeVerdict();const tc=state.benchmarkResults.length;$('#verdict-tests-count').textContent=`${tc} test${tc===1?'':'s'}`;if(!v){$('#verdict-main').innerHTML='<span class="dim">No data.</span>';$('#verdict-detail').textContent='';$('#verdict-report').innerHTML='';return;}const cl=v.closest,op=Math.abs(cl.diff)<=3;let mh;if(op)mh=`Setara dengan <span class="highlight">${cl.name}</span> <span class="dim">(${Math.abs(cl.diff)} poin · ${v.userOverall} vs ${cl.overall})</span>`;else if(cl.diff>0)mh=`Mengalahkan <span class="highlight">${cl.name}</span> <span class="dim">(+${cl.diff} poin · ${v.userOverall} vs ${cl.overall})</span>`;else mh=`Kalah tipis dari <span class="highlight">${cl.name}</span> <span class="dim">(${Math.abs(cl.diff)} poin · ${v.userOverall} vs ${cl.overall})</span>`;$('#verdict-main').innerHTML=mh;const paramsInfo=state.userModelParamsB>0?` · Your model: ${state.userModelParamsB}B params`:'';$('#verdict-detail').textContent=`Skor: ${v.userOverall}/100 dari ${tc} test. Dibandingkan ${v.comparisons.length} LLM dengan parameter serupa${paramsInfo}`;const onPar=v.comparisons.filter(c=>c.key!==cl.key&&Math.abs(c.diff)<=3);const beats=v.beats.filter(c=>c.key!==cl.key);const loses=v.losesTo.filter(c=>c.key!==cl.key);let h='';h+=`<div class="report-section"><div class="report-section-header"><span class="report-section-title neutral">Setara dengan</span><span class="report-section-count">${onPar.length} LLM</span></div>`;if(!onPar.length)h+=`<div class="report-empty">Tidak ada yang setara.</div>`;else{h+=`<div class="report-list">`;onPar.forEach(c=>{h+=`<div class="report-row neutral"><span class="report-name">${escapeHtml(c.name)}</span><span class="report-score">${c.overall}/100</span><span class="report-diff neutral">${c.diff>0?'+':''}${c.diff}</span></div>`;});h+=`</div>`;}h+=`</div>`;h+=`<div class="report-section"><div class="report-section-header"><span class="report-section-title pos">Mengalahkan</span><span class="report-section-count">${beats.length} LLM</span></div>`;if(!beats.length)h+=`<div class="report-empty">Belum mengalahkan LLM manapun.</div>`;else{h+=`<div class="report-list">`;beats.forEach(c=>{h+=`<div class="report-row pos"><span class="report-name">${escapeHtml(c.name)}</span><span class="report-score">${c.overall}/100</span><span class="report-diff pos">+${c.diff}</span></div>`;});h+=`</div>`;}h+=`</div>`;h+=`<div class="report-section"><div class="report-section-header"><span class="report-section-title neg">Kalah dari</span><span class="report-section-count">${loses.length} LLM</span></div>`;if(!loses.length)h+=`<div class="report-empty">Tidak ada yang lebih kuat — juara!</div>`;else{h+=`<div class="report-list">`;loses.forEach(c=>{h+=`<div class="report-row neg"><span class="report-name">${escapeHtml(c.name)}</span><span class="report-score">${c.overall}/100</span><span class="report-diff neg">${c.diff}</span></div>`;});h+=`</div>`;}h+=`</div>`;h+=`<div class="report-source">Source: ${escapeHtml(state.benchmarkSource||'static fallback')}${paramsInfo}</div>`;$('#verdict-report').innerHTML=h;}
function renderDimScores(){const s=aggScores();const c=$('#dim-scores');if(!s){c.innerHTML='';return;}let h='';DIMENSIONS.forEach(d=>{const v=s[d.key];h+=`<div class="dim-row"><div class="dim-label-row"><span class="dim-label">${d.label}</span><span class="dim-value">${v}/100</span></div><div class="dim-bar-bg"><div class="dim-bar"style="width:${v}%"></div></div><div class="dim-hint">${d.hint}</div></div>`;});c.innerHTML=h;}
function renderCompareSelect(){const s=$('#radar-compare-select');if(!s)return;const b=Object.keys(state.benchmarks).length?state.benchmarks:BENCHMARKS_FALLBACK;let o='';Object.entries(b).forEach(([k,v])=>{o+=`<option value="${k}">${v.name}</option>`;});s.innerHTML=o;s.value=state.radarCompareKey in b?state.radarCompareKey:Object.keys(b)[0]||'';state.radarCompareKey=s.value;}
function renderRadarChart(){const s=aggScores();if(!s)return;const b=Object.keys(state.benchmarks).length?state.benchmarks:BENCHMARKS_FALLBACK;const cmp=b[state.radarCompareKey];const cs=llmB2D(cmp);$('#radar-compare-name').textContent=cmp?cmp.name:'—';const svg=$('#radar-user'),W=320,H=280,cx=W/2,cy=H/2+8,R=95,n=DIMENSIONS.length;let h='';for(let i=1;i<=5;i++){const r=R*i/5;const p=DIMENSIONS.map((_,j)=>{const a=-Math.PI/2+j*2*Math.PI/n;return`${(cx+r*Math.cos(a)).toFixed(1)},${(cy+r*Math.sin(a)).toFixed(1)}`;}).join(' ');h+=`<polygon points="${p}" fill="none" stroke="${i===5?'#3f3f46':'#27272a'}" stroke-width="1"/>`;}DIMENSIONS.forEach((d,i)=>{const a=-Math.PI/2+i*2*Math.PI/n;h+=`<line x1="${cx}" y1="${cy}" x2="${(cx+R*Math.cos(a)).toFixed(1)}" y2="${(cy+R*Math.sin(a)).toFixed(1)}" stroke="#3f3f46" stroke-width="1"/>`;const lx=cx+(R+22)*Math.cos(a),ly=cy+(R+22)*Math.sin(a);h+=`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="#a1a1aa" font-size="10" font-weight="500" text-anchor="middle" dominant-baseline="middle">${d.label}</text>`;h+=`<text x="${lx.toFixed(1)}" y="${(ly+12).toFixed(1)}" fill="#10b981" font-size="9" font-family="JetBrains Mono" text-anchor="middle">${s[d.key]}</text>`;});if(cs){const cp=DIMENSIONS.map((d,i)=>{const a=-Math.PI/2+i*2*Math.PI/n;const r=R*(cs[d.key]/100);return`${(cx+r*Math.cos(a)).toFixed(1)},${(cy+r*Math.sin(a)).toFixed(1)}`;}).join(' ');h+=`<polygon points="${cp}" fill="rgba(161,161,170,0.10)" stroke="#71717a" stroke-width="1.5" stroke-dasharray="3,2"/>`;}const up=DIMENSIONS.map((d,i)=>{const a=-Math.PI/2+i*2*Math.PI/n;const r=R*(s[d.key]/100);return`${(cx+r*Math.cos(a)).toFixed(1)},${(cy+r*Math.sin(a)).toFixed(1)}`;}).join(' ');h+=`<polygon points="${up}" fill="rgba(16,185,129,0.30)" stroke="#10b981" stroke-width="2"/>`;DIMENSIONS.forEach((d,i)=>{const a=-Math.PI/2+i*2*Math.PI/n;const r=R*(s[d.key]/100);h+=`<circle cx="${(cx+r*Math.cos(a)).toFixed(1)}" cy="${(cy+r*Math.sin(a)).toFixed(1)}" r="3" fill="#10b981"/>`;});svg.innerHTML=h;}
function renderBarChart(){const u=aggOverall();const svg=$('#bar-chart'),W=700,pad={left:140,right:60,top:10,bottom:10},bH=22,rH=32,cW=W-pad.left-pad.right;const b=Object.keys(state.benchmarks).length?state.benchmarks:BENCHMARKS_FALLBACK;const rows=[{name:"Your LLM",score:u,color:'#10b981',isUser:true}];Object.entries(b).forEach(([k,v])=>rows.push({name:v.name,score:llmOS(v),color:v.color}));rows.sort((a,b)=>b.score-a.score);const H=pad.top+pad.bottom+rows.length*rH;svg.setAttribute('viewBox',`0 0 ${W} ${H}`);let h='';[25,50,75,100].forEach(v=>{const x=pad.left+cW*v/100;h+=`<line x1="${x}" y1="${pad.top}" x2="${x}" y2="${H-pad.bottom}" stroke="#27272a" stroke-width="1" stroke-dasharray="2,3"/>`;h+=`<text x="${x}" y="${H-2}" fill="#52525b" font-size="9" text-anchor="middle">${v}</text>`;});rows.forEach((r,i)=>{const y=pad.top+i*rH+4;h+=`<text x="${pad.left-8}" y="${y+bH/2+4}" fill="${r.isUser?'#10b981':'#a1a1aa'}" font-size="11" font-weight="${r.isUser?700:500}" text-anchor="end">${r.name}</text>`;h+=`<rect x="${pad.left}" y="${y}" width="${cW}" height="${bH}" fill="#27272a" rx="2"/>`;const bw=cW*r.score/100;h+=`<rect x="${pad.left}" y="${y}" width="${bw.toFixed(1)}" height="${bH}" fill="${r.color}" rx="2" ${r.isUser?'stroke="#34d399" stroke-width="1"':''}/>`;h+=`<text x="${(pad.left+bw+6).toFixed(1)}" y="${y+bH/2+4}" fill="${r.color}" font-size="11" font-weight="700" font-family="JetBrains Mono">${r.score}</text>`;});svg.innerHTML=h;}
function renderTestHistory(){const c=$('#test-history');if(!state.benchmarkResults.length){c.innerHTML='<div class="th-empty">No tests.</div>';return;}let h='';[...state.benchmarkResults].reverse().forEach(r=>{const t=new Date(r.ts).toLocaleTimeString('en-US',{hour12:false});const p=r.prompt.length>60?r.prompt.slice(0,60)+'…':r.prompt;h+=`<div class="th-row"><span class="th-time">${t}</span><span class="th-prompt"title="${escapeHtml(r.prompt)}">${escapeHtml(p)}</span><span class="th-score">${r.analysis.overall}/100</span></div>`;});c.innerHTML=h;}
function switchTab(n){$$('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===n));$$('.tab-panel').forEach(p=>p.classList.toggle('active',p.id===`tab-${n}`));}
function wireDropzone(){
  // Models dropzone
  const dzM=$('#dropzone-model'),inpM=$('#file-input-model');
  if(dzM&&inpM){
    dzM.addEventListener('click',()=>inpM.click());
    dzM.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inpM.click();}});
    inpM.addEventListener('change',()=>{if(inpM.files.length)uploadFiles(inpM.files);inpM.value='';});
    ['dragenter','dragover'].forEach(e=>dzM.addEventListener(e,ev=>{ev.preventDefault();ev.stopPropagation();dzM.classList.add('drag-over');}));
    ['dragleave','drop'].forEach(e=>dzM.addEventListener(e,ev=>{ev.preventDefault();ev.stopPropagation();dzM.classList.remove('drag-over');}));
    dzM.addEventListener('drop',e=>{if(e.dataTransfer.files?.length)uploadFiles(e.dataTransfer.files);});
  }
  // Datasets dropzone
  const dzD=$('#dropzone-dataset'),inpD=$('#file-input-dataset');
  if(dzD&&inpD){
    dzD.addEventListener('click',()=>inpD.click());
    dzD.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inpD.click();}});
    inpD.addEventListener('change',()=>{if(inpD.files.length)uploadFiles(inpD.files);inpD.value='';});
    ['dragenter','dragover'].forEach(e=>dzD.addEventListener(e,ev=>{ev.preventDefault();ev.stopPropagation();dzD.classList.add('drag-over');}));
    ['dragleave','drop'].forEach(e=>dzD.addEventListener(e,ev=>{ev.preventDefault();ev.stopPropagation();dzD.classList.remove('drag-over');}));
    dzD.addEventListener('drop',e=>{if(e.dataTransfer.files?.length)uploadFiles(e.dataTransfer.files);});
  }
  // Global drag/drop prevention
  window.addEventListener('dragover',e=>e.preventDefault());
  window.addEventListener('drop',e=>{e.preventDefault();});
}

async function init(){
  connectSocket(); wireDropzone();
  $$('.tab').forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.tab)));
  $('#run-btn').addEventListener('click',handleRun);
  $('#stop-btn').addEventListener('click',handleStop);
  $('#clear-models-btn')?.addEventListener('click',async()=>{for(const f of state.files.filter(f=>['llm','config','other'].includes(f.category))){try{await fetch(`/api/files?id=${f.id}`,{method:'DELETE'});}catch(e){}} state.files=state.files.filter(f=>!['llm','config','other'].includes(f.category));log('Models cleared.','info');renderFiles();populateModelSelects();renderRunState();});
  $('#clear-datasets-btn')?.addEventListener('click',async()=>{for(const f of state.files.filter(f=>['dataset','notebook'].includes(f.category))){try{await fetch(`/api/files?id=${f.id}`,{method:'DELETE'});}catch(e){}} state.files=state.files.filter(f=>!['dataset','notebook'].includes(f.category));log('Datasets cleared.','info');renderFiles();populateModelSelects();renderRunState();});
  $('#clear-console-btn').addEventListener('click',()=>{state.consoleLines=[];renderConsole();});
  $('#chat-input').addEventListener('input',renderChatInput);
  $('#chat-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();sendMessage();}});
  $('#chat-send-btn').addEventListener('click',sendMessage);
  $('#chat-stop-btn').addEventListener('click',stopChat);
  $('#clear-chat-btn').addEventListener('click',clearChat);
  $('#radar-compare-select').addEventListener('change',e=>{state.radarCompareKey=e.target.value;renderRadarChart();});
  $('#clear-benchmark-btn').addEventListener('click',()=>{state.benchmarkResults=[];renderBenchmark();log('Benchmark cleared.','info');});
  // Test tab: pretrained vs trained
  $$('.llm-tab').forEach(t=>t.addEventListener('click',()=>setLlmMode(t.dataset.mode)));
  $('#load-pretrained-btn')?.addEventListener('click',handleLoadPretrained);
  $('#load-trained-btn')?.addEventListener('click',handleLoadTrained);
  $('#pretrained-model-select')?.addEventListener('change',()=>{$('#load-pretrained-btn').disabled=!$('#pretrained-model-select').value;});
  // Train tab
  $('#train-model-select')?.addEventListener('change',updateTrainButton);
  $('#train-dataset-select')?.addEventListener('change',updateTrainButton);
  $('#start-train-btn')?.addEventListener('click',handleStartTrain);
  await fetchDeviceInfo(); await fetchBenchmarks(); await fetchLocalLlms(); await refreshFiles();
  renderConnection(); renderDeviceInfo(); renderFiles(); renderRunState(); renderConsole(); renderChatMessages(); renderChatInput(); renderBenchmark(); populateModelSelects();
}
document.addEventListener('DOMContentLoaded',init);
