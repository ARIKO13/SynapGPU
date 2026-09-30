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
 */
export function useMetricsSocket() {
  useEffect(() => {
    const socket = io('/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1200,
      timeout: 10000,
    })

    const setMetrics = usePlatformStore.getState().setMetrics
    const setConnected = usePlatformStore.getState().setConnected
    const setRunState = usePlatformStore.getState().setRunState
    const log = usePlatformStore.getState().log

    socket.on('connect', () => {
      setConnected(true)
      log('Telemetry stream connected.', 'success')
    })
    socket.on('disconnect', () => {
      setConnected(false)
      log('Telemetry stream disconnected.', 'warn')
    })
    socket.on('metrics', (m: Metrics) => usePlatformStore.getState().setMetrics(m))
    socket.on('session:state', (s: { runState: RunState; activeModel: string | null }) => {
      usePlatformStore.getState().setRunState(s.runState, { model: s.activeModel })
      if (s.runState === 'loading') log('Loading model into VRAM…', 'info')
      else if (s.runState === 'running') log('Model ready — inference server online.', 'success')
      else if (s.runState === 'stopped') log('Run stopped by user.', 'warn')
      else if (s.runState === 'idle') log('Session idle.', 'info')
    })

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
      socket.disconnect()
    }
  }, [])
}
