'use client'

import { useEffect, useState } from 'react'
import { Play, Square, Loader2, Cpu, Github, Wifi, WifiOff, Download, Monitor, Apple } from 'lucide-react'
import { usePlatformStore } from '@/store/platform-store'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function useUptime(startedAt: number | null) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!startedAt) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  if (!startedAt) return null
  const secs = Math.floor((Date.now() - startedAt) / 1000)
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function PlatformHeader() {
  const runState = usePlatformStore((s) => s.runState)
  const activeModel = usePlatformStore((s) => s.activeModel)
  const runStartedAt = usePlatformStore((s) => s.runStartedAt)
  const files = usePlatformStore((s) => s.files)
  const connected = usePlatformStore((s) => s.connected)
  const setRunState = usePlatformStore((s) => s.setRunState)
  const log = usePlatformStore((s) => s.log)

  const uptime = useUptime(runState === 'idle' || runState === 'stopped' || runState === 'error' ? null : runStartedAt)

  const llmFiles = files.filter((f) => f.category === 'llm')
  const canRun = llmFiles.length > 0 && (runState === 'idle' || runState === 'stopped' || runState === 'error')

  // Detect user's OS client-side so the Download button can deep-link to the
  // right asset on the GitHub releases page (Windows zip today; macOS/Linux
  // fall back to "build from source" instructions).
  const [os, setOs] = useState<'windows' | 'mac' | 'linux' | 'unknown'>('unknown')
  useEffect(() => {
    if (typeof navigator === 'undefined') return
    const ua = navigator.userAgent.toLowerCase()
    if (ua.includes('win')) setOs('windows')
    else if (ua.includes('mac')) setOs('mac')
    else if (ua.includes('linux')) setOs('linux')
    else setOs('unknown')
  }, [])

  // GitHub releases — repo: ARIKO13/SynapGPU. Latest tag is v0.8.0 and ships
  // `SynapGPU-Windows.zip`. We deep-link to the asset for the detected OS so
  // the user doesn't have to navigate the GitHub releases page themselves.
  const repoReleases = 'https://github.com/ARIKO13/SynapGPU/releases/latest'
  const downloadHref =
    os === 'windows'
      ? 'https://github.com/ARIKO13/SynapGPU/releases/latest/download/SynapGPU-Windows.zip'
      : repoReleases // macOS/Linux: no prebuilt binary yet → land on releases page

  function onDownloadClick() {
    log(`Membuka halaman download SynapGPU Desktop (${os || 'unknown OS'})…`, 'info')
  }

  async function handleRun() {
    const model = llmFiles[0]?.name ?? null
    log(`Run dispatched for model: ${model ?? '(no model)'}`, 'info')
    // The frontend forwards run:start over WebSocket — the metrics service is
    // the source of truth for telemetry transitions.
    try {
      // Notify the run API (kept for future real-backend wiring).
      await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', model }),
      })
    } catch {
      /* non-fatal — the WebSocket is the real signal */
    }
    setRunState('loading', { model })
  }

  async function handleStop() {
    log('Stop dispatched.', 'warn')
    try {
      await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      })
    } catch {
      /* ignore */
    }
    setRunState('stopped')
  }

  return (
    <header className="flex items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-950/80 px-4 py-2.5 backdrop-blur">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-lg shadow-emerald-500/30">
          <Cpu className="h-4 w-4 text-zinc-950" />
        </div>
        <div className="flex flex-col leading-tight">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold tracking-tight text-zinc-100">ColabGPU</span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-zinc-400">
              v0.1 · WebGPU
            </span>
          </div>
          <span className="text-[10px] text-zinc-500">Drag · Drop · Run · Monitor</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {/* Active model badge */}
        {activeModel && (
          <div className="hidden items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-[11px] text-zinc-400">model:</span>
            <span className="font-mono text-xs text-emerald-300">{activeModel}</span>
            {uptime && (
              <>
                <span className="text-zinc-700">·</span>
                <span className="font-mono text-[11px] text-zinc-500">{uptime}</span>
              </>
            )}
          </div>
        )}

        {/* Download SynapGPU Desktop — deep-links to the GitHub release asset
            for the user's detected OS. Hidden on small screens to save space;
            it's also reachable from the chat-tester's "Trained Model" panel
            via the manifest.json download note. */}
        <a
          href={downloadHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onDownloadClick}
          className={cn(
            'hidden items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-medium transition sm:flex',
            'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20',
          )}
          title={
            os === 'windows'
              ? 'Download SynapGPU-Windows.zip (~14 MB, no install needed)'
              : os === 'mac'
                ? 'Download SynapGPU Desktop (macOS — build from source)'
                : os === 'linux'
                  ? 'Download SynapGPU Desktop (Linux — build from source)'
                  : 'Download SynapGPU Desktop from GitHub'
          }
        >
          {os === 'mac' ? <Apple className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
          <span>Download Desktop</span>
          {os === 'windows' && (
            <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
              Win
            </span>
          )}
        </a>

        {/* Connection */}
        <div className={cn(
          'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium',
          connected
            ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
            : 'border-zinc-700 bg-zinc-900/60 text-zinc-500',
        )}>
          {connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          <span className="hidden sm:inline">{connected ? 'connected' : 'offline'}</span>
        </div>

        {/* Run / Stop button */}
        {runState === 'running' || runState === 'loading' ? (
          <Button
            onClick={handleStop}
            variant="destructive"
            size="sm"
            className="gap-2"
          >
            {runState === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
            {runState === 'loading' ? 'Loading…' : 'Stop'}
          </Button>
        ) : (
          <Button
            onClick={handleRun}
            disabled={!canRun}
            size="sm"
            className="gap-2 bg-emerald-600 text-zinc-950 hover:bg-emerald-500 disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5" />
            Run
          </Button>
        )}
      </div>
    </header>
  )
}
