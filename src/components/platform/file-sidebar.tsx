'use client'

import { useMemo } from 'react'
import { FileBox, FileText, Database, Settings2, File as FileIcon, Trash2, Cpu } from 'lucide-react'
import { usePlatformStore, type FileRecord, type FileCategory } from '@/store/platform-store'
import { Dropzone } from './dropzone'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

const CATEGORY_META: Record<FileCategory, { label: string; icon: React.ReactNode; color: string }> = {
  llm:     { label: 'LLM Models',   icon: <Cpu className="h-3.5 w-3.5" />,        color: 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20' },
  dataset: { label: 'Datasets',     icon: <Database className="h-3.5 w-3.5" />,    color: 'text-cyan-400 bg-cyan-500/10 ring-cyan-500/20' },
  config:  { label: 'Config Files', icon: <Settings2 className="h-3.5 w-3.5" />,   color: 'text-amber-400 bg-amber-500/10 ring-amber-500/20' },
  other:   { label: 'Other Files',  icon: <FileText className="h-3.5 w-3.5" />,    color: 'text-zinc-400 bg-zinc-500/10 ring-zinc-500/20' },
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

function FileRow({ file }: { file: FileRecord }) {
  const remove = usePlatformStore((s) => s.removeFile)
  const meta = CATEGORY_META[file.category]
  return (
    <div className="group flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-2 py-2 transition hover:border-zinc-700 hover:bg-zinc-900/80">
      <span className={cn('rounded-md p-1 ring-1 ring-inset', meta.color)}>{meta.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-zinc-200">{file.name}</p>
        <p className="text-[10px] text-zinc-500">{humanSize(file.sizeBytes)} · {new Date(file.uploadedAt).toLocaleTimeString('id-ID', { hour12: false })}</p>
      </div>
      <button
        onClick={() => remove(file.id)}
        className="opacity-0 transition group-hover:opacity-100"
        title="Hapus file"
      >
        <Trash2 className="h-3.5 w-3.5 text-zinc-500 hover:text-rose-400" />
      </button>
    </div>
  )
}

export function FileSidebar() {
  const files = usePlatformStore((s) => s.files)
  const clearFiles = usePlatformStore((s) => s.clearFiles)
  const activeModel = usePlatformStore((s) => s.activeModel)

  const grouped = useMemo(() => {
    const g: Record<FileCategory, FileRecord[]> = { llm: [], dataset: [], config: [], other: [] }
    files.forEach((f) => g[f.category].push(f))
    return g
  }, [files])

  const totalSize = useMemo(() => files.reduce((a, f) => a + f.sizeBytes, 0), [files])

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-800 bg-zinc-900/40 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileBox className="h-4 w-4 text-emerald-400" />
            <span className="text-sm font-semibold text-zinc-200">File Manager</span>
          </div>
          {files.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearFiles} className="h-7 gap-1 px-2 text-[11px] text-zinc-500 hover:text-rose-300">
              <Trash2 className="h-3 w-3" /> Clear all
            </Button>
          )}
        </div>
        {files.length > 0 && (
          <div className="mt-2 flex items-center gap-2 text-[10px] text-zinc-500">
            <span className="rounded bg-zinc-800 px-1.5 py-0.5">{files.length} files</span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5">{humanSize(totalSize)}</span>
            {activeModel && (
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
                active: {activeModel}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="p-3">
        <Dropzone />
      </div>

      <ScrollArea className="flex-1 px-3 pb-3">
        {files.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
            <FileIcon className="h-6 w-6 text-zinc-700" />
            <p className="text-xs text-zinc-500">Belum ada file di-upload</p>
            <p className="text-[10px] text-zinc-600">Drag & drop LLM, dataset, atau config untuk mulai</p>
          </div>
        ) : (
          <div className="space-y-4">
            {(Object.entries(grouped) as [FileCategory, FileRecord[]][]).map(([cat, list]) =>
              list.length === 0 ? null : (
                <div key={cat} className="space-y-2">
                  <div className="flex items-center gap-2 px-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      {CATEGORY_META[cat].label}
                    </span>
                    <span className="text-[10px] text-zinc-600">· {list.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {list.map((f) => <FileRow key={f.id} file={f} />)}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
