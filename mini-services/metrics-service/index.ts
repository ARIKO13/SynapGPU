import { createServer } from 'http'
import { Server } from 'socket.io'

const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path — Caddy uses it to route the request.
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// ---------------------------------------------------------------------------
// Session state. We keep this in-memory because the platform is single-user.
// ---------------------------------------------------------------------------
type RunState = 'idle' | 'loading' | 'running' | 'stopped' | 'error'

interface SessionState {
  runState: RunState
  runStartedAt: number | null
  // Active model name (the first uploaded LLM file).
  activeModel: string | null
  // Whether the test chat is active.
  chatActive: boolean
}

const session: SessionState = {
  runState: 'idle',
  runStartedAt: null,
  activeModel: null,
  chatActive: false,
}

// ---------------------------------------------------------------------------
// Metrics generation. In a real deployment you'd read /proc, nvidia-smi, etc.
// Here we produce plausible-looking telemetry that reacts to the run state.
// ---------------------------------------------------------------------------
interface Metrics {
  ts: number
  gpu: { utilization: number; memoryUsedGb: number; memoryTotalGb: number; tempC: number; powerW: number }
  ram: { usedGb: number; totalGb: number }
  ssd: { usedGb: number; totalGb: number; readMbps: number; writeMbps: number }
  net: { rxMbps: number; txMbps: number }
}

const GPU_TOTAL_GB = 24 // RTX-class card
const RAM_TOTAL_GB = 64
const SSD_TOTAL_GB = 1024
const SSD_BASE_USED_GB = 312

// Smooth noise helper — produces a value that drifts around `target`.
function drift(prev: number, target: number, maxStep: number, min = 0, max = 100): number {
  const delta = (target - prev) * 0.18 + (Math.random() - 0.5) * maxStep
  const next = prev + delta
  return Math.max(min, Math.min(max, next))
}

let gpuUtil = 0
let gpuMem = 0
let gpuTemp = 35
let gpuPower = 25
let ramUsed = 6.4
let ssdRead = 0
let ssdWrite = 0
let netRx = 0
let netTx = 0

function computeMetrics(): Metrics {
  let gpuTarget = 0
  let ramTarget = 6.4
  let ssdReadTarget = 0
  let ssdWriteTarget = 0
  let netRxTarget = 0
  let netTxTarget = 0

  if (session.runState === 'loading') {
    // Loading model into VRAM: GPU memory climbs, some compute, lots of SSD read.
    gpuTarget = 35
    gpuMem = Math.min(GPU_TOTAL_GB * 0.78, gpuMem + 0.45)
    ramTarget = 14
    ssdReadTarget = 850
    ssdWriteTarget = 20
    netRxTarget = 5
  } else if (session.runState === 'running') {
    // Inference mode — high util, lots of memory.
    gpuTarget = 72 + Math.sin(Date.now() / 600) * 14
    if (gpuMem < GPU_TOTAL_GB * 0.55) gpuMem = GPU_TOTAL_GB * 0.55
    ramTarget = 22 + Math.sin(Date.now() / 900) * 4
    ssdReadTarget = 60
    ssdWriteTarget = 35
    netRxTarget = session.chatActive ? 8 : 2
    netTxTarget = session.chatActive ? 6 : 1
  } else if (session.runState === 'error') {
    gpuTarget = 5
    ramTarget = 9
  } else {
    // idle / stopped — decay.
    gpuTarget = 0
    gpuMem = Math.max(0, gpuMem - 0.4)
    ramTarget = 6.4
    ssdReadTarget = 0
    ssdWriteTarget = 0
    netRxTarget = 0.5
    netTxTarget = 0.5
  }

  gpuUtil = drift(gpuUtil, gpuTarget, 6)
  gpuTemp = drift(gpuTemp, session.runState === 'running' ? 71 : 35, 1, 30, 90)
  gpuPower = drift(gpuPower, session.runState === 'running' ? 280 : session.runState === 'loading' ? 140 : 25, 18, 15, 450)
  ramUsed = drift(ramUsed, ramTarget, 0.5, 4, RAM_TOTAL_GB)
  ssdRead = drift(ssdRead, ssdReadTarget, 80, 0, 2000)
  ssdWrite = drift(ssdWrite, ssdWriteTarget, 30, 0, 800)
  netRx = drift(netRx, netRxTarget, 1.5, 0, 50)
  netTx = drift(netTx, netTxTarget, 1.2, 0, 50)

  return {
    ts: Date.now(),
    gpu: {
      utilization: gpuUtil,
      memoryUsedGb: gpuMem,
      memoryTotalGb: GPU_TOTAL_GB,
      tempC: gpuTemp,
      powerW: gpuPower,
    },
    ram: { usedGb: ramUsed, totalGb: RAM_TOTAL_GB },
    ssd: {
      usedGb: SSD_BASE_USED_GB + gpuMem * 0.001, // tiny increment as the model is cached
      totalGb: SSD_TOTAL_GB,
      readMbps: ssdRead,
      writeMbps: ssdWrite,
    },
    net: { rxMbps: netRx, txMbps: netTx },
  }
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`[metrics] client connected: ${socket.id}`)
  // Send current state immediately so reconnects don't lose sync.
  socket.emit('session:state', session)

  socket.on('run:start', (payload: { model?: string | null } | undefined) => {
    console.log('[metrics] run:start', payload)
    session.runState = 'loading'
    session.runStartedAt = Date.now()
    session.activeModel = payload?.model ?? session.activeModel
    io.emit('session:state', session)
    // After ~4.5s of "loading", transition to running.
    setTimeout(() => {
      if (session.runState === 'loading') {
        session.runState = 'running'
        io.emit('session:state', session)
      }
    }, 4500)
  })

  socket.on('run:stop', () => {
    console.log('[metrics] run:stop')
    session.runState = 'stopped'
    session.runStartedAt = null
    io.emit('session:state', session)
    // After 2s, return to idle so metrics decay.
    setTimeout(() => {
      if (session.runState === 'stopped') {
        session.runState = 'idle'
        io.emit('session:state', session)
      }
    }, 2000)
  })

  socket.on('chat:active', (active: boolean) => {
    session.chatActive = active
  })

  socket.on('disconnect', () => {
    console.log(`[metrics] client disconnected: ${socket.id}`)
  })
})

// Broadcast metrics every 1s.
setInterval(() => {
  io.emit('metrics', computeMetrics())
}, 1000)

const PORT = 3003
httpServer.listen(PORT, () => {
  console.log(`[metrics] WebSocket server running on port ${PORT}`)
})

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)))
process.on('SIGINT', () => httpServer.close(() => process.exit(0)))
