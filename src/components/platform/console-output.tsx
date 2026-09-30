'use client'

import { useEffect, useRef } from 'react'
import { Terminal, Trash2 } from 'lucide-react'
import { usePlatformStore } from '@/store/platform-store'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const LEVEL_STYLES: Record<string, { text: string; prefix: string }> = {
  info:    { text: 'text-zinc-300',  prefix: 'text-zinc-600' },
  warn:    { text: 'text-amber-300', prefix: 'text-amber-500' },
  error:   { text: 'text-rose-300', prefix: 'text-rose-500' },
  success: { text: 'text-emerald-300', prefix: 'text-emerald-500' },
}

export function ConsoleOutput() {
  const lines = usePlatformStore((s) => s.consoleLines)
  const clear = usePlatformStore((s) => s.clearConsole)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/40 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-emerald-400" />
          <span className="text-sm font-medium text-zinc-200">Console Output</span>
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-400">{lines.length} lines</span>
        </div>
        <Button variant="ghost" size="sm" onClick={clear} className="h-7 gap-1 text-xs text-zinc-400 hover:text-zinc-200">
          <Trash2 className="h-3 w-3" /> Clear
        </Button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-zinc-950/60 p-4 font-mono text-xs">
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-600">
            <p>Belum ada output. Drag & drop file lalu klik Run untuk mulai.</p>
          </div>
        ) : (
          <div className="space-y-1">
            {lines.map((l) => {
              const s = LEVEL_STYLES[l.level] ?? LEVEL_STYLES.info
              return (
                <div key={l.id} className="flex items-start gap-3">
                  <span className="shrink-0 text-zinc-600">
                    {new Date(l.ts).toLocaleTimeString('id-ID', { hour12: false })}
                  </span>
                  <span className={cn('shrink-0 font-bold', s.prefix)}>
                    {l.level === 'info' ? 'ℹ' : l.level === 'warn' ? '⚠' : l.level === 'error' ? '✗' : '✓'}
                  </span>
                  <span className={cn('whitespace-pre-wrap break-words', s.text)}>{l.text}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
