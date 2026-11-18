'use client'

import { useEffect } from 'react'
import { Activity, Terminal, MessageSquare, Cpu, MemoryStick, HardDrive } from 'lucide-react'
import { usePlatformStore, type FileRecord } from '@/store/platform-store'
import { useMetricsSocket } from '@/hooks/use-metrics-socket'
import { PlatformHeader } from '@/components/platform/platform-header'
import { FileSidebar } from '@/components/platform/file-sidebar'
import { MonitoringDashboard } from '@/components/platform/monitoring-dashboard'
import { ConsoleOutput } from '@/components/platform/console-output'
import { ChatTester } from '@/components/platform/chat-tester'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

function FooterStatus() {
  const connected = usePlatformStore((s) => s.connected)
  const metrics = usePlatformStore((s) => s.metrics)
  const runState = usePlatformStore((s) => s.runState)
  const files = usePlatformStore((s) => s.files)

  const statusColor =
    runState === 'running' ? 'text-emerald-400' :
    runState === 'loading' ? 'text-amber-400' :
    runState === 'error' ? 'text-rose-400' : 'text-zinc-500'

  return (
    <footer className="mt-auto flex items-center justify-between gap-4 border-t border-zinc-800 bg-zinc-950/80 px-4 py-1.5 text-[11px] backdrop-blur">
      <div className="flex items-center gap-3">
        <span className={cn('flex items-center gap-1.5', connected ? 'text-emerald-400' : 'text-zinc-500')}>
          <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-zinc-600')} />
          {connected ? 'telemetry live' : 'telemetry offline'}
        </span>
        <span className="text-zinc-700">·</span>
        <span className={statusColor}>{runState}</span>
        <span className="text-zinc-700">·</span>
        <span className="text-zinc-500">{files.length} files staged</span>
      </div>
      {metrics && (
        <div className="hidden items-center gap-4 font-mono text-zinc-500 sm:flex">
          <span className="flex items-center gap-1">
            <Cpu className="h-3 w-3" /> {metrics.gpu.utilization.toFixed(0)}%
          </span>
          <span className="flex items-center gap-1">
            <MemoryStick className="h-3 w-3" /> {((metrics.ram.usedGb / metrics.ram.totalGb) * 100).toFixed(0)}%
          </span>
          <span className="flex items-center gap-1">
            <HardDrive className="h-3 w-3" /> {((metrics.ssd.usedGb / metrics.ssd.totalGb) * 100).toFixed(0)}%
          </span>
        </div>
      )}
    </footer>
  )
}

export default function Home() {
  // Subscribes to the metrics mini-service and forwards run-state transitions.
  useMetricsSocket()

  const files = usePlatformStore((s) => s.files)
  const addFiles = usePlatformStore((s) => s.addFiles)
  const runState = usePlatformStore((s) => s.runState)
  const log = usePlatformStore((s) => s.log)

  // Welcome message once on mount + re-fetch any previously uploaded files
  // from the server. Files are persisted server-side in /api/files (in-memory),
  // so a page reload would otherwise leave the sidebar empty even though the
  // server still knows about the files. This fetch restores them on mount.
  useEffect(() => {
    log('ColabGPU siap. Drag & drop file LLM/dataset ke sidebar, lalu klik Run.', 'info')
    ;(async () => {
      try {
        const res = await fetch('/api/files')
        if (!res.ok) return
        const data = await res.json()
        const serverFiles: FileRecord[] = (data.files ?? []).map((f: FileRecord) => ({
          ...f,
          uploadedAt: typeof f.uploadedAt === 'string' ? Date.parse(f.uploadedAt) : f.uploadedAt,
        }))
        // Only add files the store doesn't already know about (de-dup by id).
        const known = new Set(usePlatformStore.getState().files.map((f) => f.id))
        const newOnes = serverFiles.filter((f) => !known.has(f.id))
        if (newOnes.length > 0) {
          addFiles(newOnes)
          log(`Memulihkan ${newOnes.length} file dari sesi sebelumnya.`, 'info')
        }
      } catch {
        // Non-fatal — server may not be reachable yet, but UI still works.
      }
    })()
  }, [log, addFiles])

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <PlatformHeader />

      {/* Body: sidebar + main */}
      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        {/* Sidebar - fixed width on lg+, becomes a panel above content on mobile */}
        <aside className="h-[40vh] w-full shrink-0 border-b border-zinc-800 bg-zinc-950 lg:h-auto lg:w-[340px] lg:border-b-0 lg:border-r">
          <FileSidebar />
        </aside>

        {/* Main workspace */}
        <main className="flex flex-1 flex-col overflow-hidden">
          <Tabs defaultValue="dashboard" className="flex h-full flex-1 flex-col overflow-hidden">
            <div className="border-b border-zinc-800 bg-zinc-950/60 px-3 py-2">
              <TabsList className="bg-zinc-900/60">
                <TabsTrigger value="dashboard" className="gap-1.5 data-[state=active]:bg-zinc-800 data-[state=active]:text-emerald-400">
                  <Activity className="h-3.5 w-3.5" /> Dashboard
                </TabsTrigger>
                <TabsTrigger value="console" className="gap-1.5 data-[state=active]:bg-zinc-900 data-[state=active]:text-emerald-400">
                  <Terminal className="h-3.5 w-3.5" /> Console
                </TabsTrigger>
                <TabsTrigger value="chat" className="gap-1.5 data-[state=active]:bg-zinc-900 data-[state=active]:text-emerald-400">
                  <MessageSquare className="h-3.5 w-3.5" /> Test LLM
                  {runState === 'running' && (
                    <span className="ml-1 h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="dashboard" className="m-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
              <MonitoringDashboard />
            </TabsContent>
            <TabsContent value="console" className="m-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
              <ConsoleOutput />
            </TabsContent>
            <TabsContent value="chat" className="m-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
              <ChatTester />
            </TabsContent>
          </Tabs>
        </main>
      </div>

      <FooterStatus />
    </div>
  )
}
