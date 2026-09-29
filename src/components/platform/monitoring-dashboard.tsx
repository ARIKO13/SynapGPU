'use client'

import { useMemo } from 'react'
import { Cpu, MemoryStick, HardDrive, Thermometer, Zap, Activity, Network } from 'lucide-react'
import { usePlatformStore, type Metrics } from '@/store/platform-store'
import { MetricCard } from './metric-card'
import { cn } from '@/lib/utils'

function Sparkline({ data, color, height = 40 }: { data: number[]; color: string; height?: number }) {
  const width = 200
  if (data.length < 2) {
    return <div style={{ height }} className="w-full rounded bg-zinc-800/40" />
  }
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width
      const y = height - ((v - min) / range) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="block">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function statusAccent(percent: number): 'emerald' | 'amber' | 'rose' {
  if (percent >= 90) return 'rose'
  if (percent >= 70) return 'amber'
  return 'emerald'
}

export function MonitoringDashboard() {
  const metrics = usePlatformStore((s) => s.metrics)
  const history = usePlatformStore((s) => s.metricsHistory)
  const runState = usePlatformStore((s) => s.runState)
  const connected = usePlatformStore((s) => s.connected)

  const gpuHist = useMemo(() => history.map((m) => m.gpu.utilization), [history])
  const gpuMemHist = useMemo(
    () => history.map((m) => (m.gpu.memoryUsedGb / m.gpu.memoryTotalGb) * 100),
    [history],
  )
  const ramHist = useMemo(
    () => history.map((m) => (m.ram.usedGb / m.ram.totalGb) * 100),
    [history],
  )
  const ssdReadHist = useMemo(() => history.map((m) => m.ssd.readMbps), [history])

  if (!metrics || !connected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <div className="relative h-12 w-12">
          <div className="absolute inset-0 rounded-full border-2 border-zinc-800" />
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-emerald-500 animate-spin" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-zinc-300">Menunggu koneksi telemetry…</p>
          <p className="text-xs text-zinc-500">
            Mini-service WebSocket di port 3003 harus aktif. Jalankan <code className="font-mono text-emerald-400">bun run dev</code> di <code className="font-mono text-emerald-400">mini-services/metrics-service</code>.
          </p>
        </div>
      </div>
    )
  }

  const gpuUtil = metrics.gpu.utilization
  const gpuMemPct = (metrics.gpu.memoryUsedGb / metrics.gpu.memoryTotalGb) * 100
  const ramPct = (metrics.ram.usedGb / metrics.ram.totalGb) * 100
  const ssdPct = (metrics.ssd.usedGb / metrics.ssd.totalGb) * 100

  return (
    <div className="space-y-4 p-4">
      {/* Top status bar */}
      <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className={cn('h-2 w-2 rounded-full',
            runState === 'running' ? 'bg-emerald-500 animate-pulse' :
            runState === 'loading' ? 'bg-amber-500 animate-pulse' :
            runState === 'error' ? 'bg-rose-500' : 'bg-zinc-600')} />
          <span className="text-sm font-medium text-zinc-200">
            {runState === 'idle' && 'Sistem idle'}
            {runState === 'loading' && 'Memuat model ke VRAM…'}
            {runState === 'running' && 'Model aktif — inference berjalan'}
            {runState === 'stopped' && 'Run dihentikan'}
            {runState === 'error' && 'Terjadi error'}
          </span>
        </div>
        <span className="font-mono text-xs text-zinc-500">
          {new Date(metrics.ts).toLocaleTimeString('id-ID', { hour12: false })}
        </span>
      </div>

      {/* Main metric cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="GPU Util"
          value={`${gpuUtil.toFixed(1)}%`}
          percent={gpuUtil}
          accent={statusAccent(gpuUtil)}
          icon={<Cpu className="h-4 w-4" />}
          footer={
            <div className="flex items-center justify-between">
              <span>VRAM {metrics.gpu.memoryUsedGb.toFixed(1)} / {metrics.gpu.memoryTotalGb.toFixed(0)} GB</span>
            </div>
          }
        />
        <MetricCard
          label="GPU Memory"
          value={`${gpuMemPct.toFixed(1)}%`}
          percent={gpuMemPct}
          accent={statusAccent(gpuMemPct)}
          icon={<MemoryStick className="h-4 w-4" />}
          footer={<Sparkline data={gpuMemHist} color="#10b981" />}
        />
        <MetricCard
          label="RAM"
          value={`${ramPct.toFixed(0)}%`}
          subValue={`${metrics.ram.usedGb.toFixed(1)}/${metrics.ram.totalGb} GB`}
          percent={ramPct}
          accent={statusAccent(ramPct)}
          icon={<Activity className="h-4 w-4" />}
          footer={<Sparkline data={ramHist} color="#06b6d4" />}
        />
        <MetricCard
          label="SSD"
          value={`${ssdPct.toFixed(1)}%`}
          subValue={`${metrics.ssd.usedGb.toFixed(0)}/${metrics.ssd.totalGb} GB`}
          percent={ssdPct}
          accent={statusAccent(ssdPct)}
          icon={<HardDrive className="h-4 w-4" />}
          footer={
            <span>R {metrics.ssd.readMbps.toFixed(0)} MB/s · W {metrics.ssd.writeMbps.toFixed(0)} MB/s</span>
          }
        />
      </div>

      {/* Secondary metrics */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="GPU Temp"
          value={`${metrics.gpu.tempC.toFixed(0)}°C`}
          accent={metrics.gpu.tempC >= 80 ? 'rose' : metrics.gpu.tempC >= 65 ? 'amber' : 'emerald'}
          icon={<Thermometer className="h-4 w-4" />}
        />
        <MetricCard
          label="GPU Power"
          value={`${metrics.gpu.powerW.toFixed(0)} W`}
          accent="amber"
          icon={<Zap className="h-4 w-4" />}
        />
        <MetricCard
          label="Network RX"
          value={`${metrics.net.rxMbps.toFixed(1)} Mbps`}
          accent="cyan"
          icon={<Network className="h-4 w-4" />}
        />
        <MetricCard
          label="Network TX"
          value={`${metrics.net.txMbps.toFixed(1)} Mbps`}
          accent="cyan"
          icon={<Network className="h-4 w-4" />}
        />
      </div>

      {/* GPU utilization chart */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">GPU Utilization (60s)</h3>
          <span className="font-mono text-xs text-zinc-500">{gpuUtil.toFixed(1)}% avg</span>
        </div>
        <Sparkline data={gpuHist} color="#10b981" height={80} />
        <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
          <span>SSD Read: {metrics.ssd.readMbps.toFixed(0)} MB/s</span>
          <span>SSD Write: {metrics.ssd.writeMbps.toFixed(0)} MB/s</span>
        </div>
        <div className="mt-2">
          <Sparkline data={ssdReadHist} color="#f59e0b" height={40} />
        </div>
      </div>
    </div>
  )
}
