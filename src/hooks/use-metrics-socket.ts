'use client'

import { useEffect } from 'react'
import { io, type Socket } from 'socket.io-client'
import { usePlatformStore, type Metrics, type RunState } from '@/store/platform-store'

/**
 * Subscribes to the metrics mini-service over WebSocket and updates the
 * platform store with the latest metrics + run-state transitions.
 *
 * Also forwards run:start / run:stop events to the metrics service whenever
 * the local run-state changes — keeping the metrics service (a separate
 * process on port 3003) in sync with the UI as the single source of truth
 * for telemetry.
 *
 * Connection resilience:
 * - On `connect_error` we mark the connection as failed so the dashboard can
 *   show a clear "Backend offline" message instead of spinning forever.
 * - An 8-second timeout drops the "Connecting…" panel to the offline state
 *   if neither `connect` nor `metrics` has fired by then. Without this,
 *   a missing mini-service would leave the dashboard stuck indefinitely.
 */
export function useMetricsSocket() {
  useEffect(() => {
    // Connect to /socket.io/ on the same origin. Next.js rewrites this to
    // http://localhost:3003/socket.io/ via next.config.ts → rewrites(), so
    // the socket.io client doesn't need to know the metrics service port
    // or rely on the external preview gateway preserving any query param.
    //
    // Note: we use `polling` transport only with `upgrade: false`. The
    // default `['websocket', 'polling']` ordering with v4.8.4 was causing
    // the client to attempt a WebSocket upgrade first that silently
    // stalled through Next.js's rewrite proxy — the client never fell
    // back to polling and never connected. Polling-only is also more
    // robust through reverse proxies (Caddy, Cloudflare, etc.) that may
    // not handle the WS upgrade cleanly.
    const socket = io({
      path: '/socket.io/',
      transports: ['polling'],
      upgrade: false,
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1200,
      timeout: 10000,
    })

    const setMetrics = usePlatformStore.getState().setMetrics
    const setConnected = usePlatformStore.getState().setConnected
    const setConnectionFailed = usePlatformStore.getState().setConnectionFailed
    const setRunState = usePlatformStore.getState().setRunState
    const log = usePlatformStore.getState().log

    let hasEverConnected = false

    socket.on('connect', () => {
      hasEverConnected = true
      setConnected(true)
      setConnectionFailed(false)
      log('Telemetry stream connected.', 'success')
    })
    socket.on('disconnect', () => {
      setConnected(false)
      log('Telemetry stream disconnected.', 'warn')
    })
    socket.on('connect_error', (err: Error) => {
      // Only log the first failure — socket.io retries aggressively and we
      // don't want to spam the console.
      if (!usePlatformStore.getState().connectionFailed) {
        setConnectionFailed(true)
        log(
          `Cannot reach metrics service on port 3003 — ${err.message}. Run \`bun run dev\` in mini-services/metrics-service.`,
          'error',
        )
      }
    })
    socket.on('metrics', (m: Metrics) => usePlatformStore.getState().setMetrics(m))
    socket.on('session:state', (s: { runState: RunState; activeModel: string | null }) => {
      usePlatformStore.getState().setRunState(s.runState, { model: s.activeModel })
      if (s.runState === 'loading') log('Loading model into VRAM…', 'info')
      else if (s.runState === 'running') log('Model ready — inference server online.', 'success')
      else if (s.runState === 'stopped') log('Run stopped by user.', 'warn')
      else if (s.runState === 'idle') log('Session idle.', 'info')
    })

    // Fallback: if still no connection after 8s, flip to offline state so
    // the dashboard stops spinning. The socket will keep retrying in the
    // background and will clear `connectionFailed` if/when it connects.
    const fallbackTimer = setTimeout(() => {
      if (!hasEverConnected && !usePlatformStore.getState().metrics) {
        setConnectionFailed(true)
      }
    }, 8000)

    // Forward run-state transitions to the metrics service so it can update
    // its simulated telemetry. The local UI is the source of truth for the
    // transition; the metrics service is the source of truth for the
    // subsequent metric stream.
    const unsub = usePlatformStore.subscribe((s, prev) => {
      if (s.runState === prev.runState) return
      if (s.runState === 'loading') {
        socket.emit('run:start', { model: s.activeModel })
      } else if (s.runState === 'stopped' || s.runState === 'idle' || s.runState === 'error') {
        socket.emit('run:stop')
      }
    })

    return () => {
      unsub()
      clearTimeout(fallbackTimer)
      socket.disconnect()
    }
  }, [])
}
