'use client'

import { useState, useCallback, useRef } from 'react'
import { UploadCloud, FileUp } from 'lucide-react'
import { usePlatformStore, type FileRecord } from '@/store/platform-store'
import { cn } from '@/lib/utils'

interface CategoryMeta {
  label: string
  hint: string
  exts: string[]
}

const CATEGORIES: Record<string, CategoryMeta> = {
  llm: { label: 'LLM Model', hint: '.gguf .bin .safetensors .pt .onnx', exts: ['gguf', 'bin', 'safetensors', 'pt', 'pth', 'onnx', 'ggmf'] },
  dataset: { label: 'Dataset', hint: '.csv .jsonl .parquet .txt', exts: ['csv', 'json', 'jsonl', 'parquet', 'txt', 'tsv', 'arrow'] },
  config: { label: 'Config', hint: '.yaml .toml .json', exts: ['yaml', 'yml', 'toml', 'ini', 'conf'] },
  other: { label: 'Other', hint: 'any file', exts: [] },
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

export function Dropzone() {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const addFiles = usePlatformStore((s) => s.addFiles)
  const setUploading = usePlatformStore((s) => s.setUploading)
  const isUploading = usePlatformStore((s) => s.isUploading)
  const log = usePlatformStore((s) => s.log)

  const upload = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    if (files.length === 0) return
    setUploading(true)
    log(`Mengunggah ${files.length} file: ${files.map((f) => f.name).join(', ')}`, 'info')
    try {
      const formData = new FormData()
      files.forEach((f) => formData.append('files', f))
      const res = await fetch('/api/files', { method: 'POST', body: formData })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      addFiles(data.created as FileRecord[])
      log(`Berhasil mengunggah ${data.created.length} file (${humanSize(data.created.reduce((a: number, f: FileRecord) => a + f.sizeBytes, 0))}).`, 'success')
    } catch (e) {
      log(`Gagal upload: ${(e as Error).message}`, 'error')
    } finally {
      setUploading(false)
    }
  }, [addFiles, setUploading, log])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files?.length) upload(e.dataTransfer.files)
  }, [upload])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  return (
    <div
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      className={cn(
        'relative rounded-xl border-2 border-dashed p-4 text-center transition-all',
        isDragging
          ? 'border-emerald-500 bg-emerald-500/5 scale-[1.01]'
          : 'border-zinc-700 bg-zinc-900/40 hover:border-zinc-600',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && upload(e.target.files)}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={isUploading}
        className="flex w-full flex-col items-center gap-2 py-3 disabled:opacity-50"
      >
        <div className={cn('rounded-full border border-zinc-700 bg-zinc-900 p-2.5', isUploading && 'animate-pulse')}>
          {isUploading ? <FileUp className="h-5 w-5 text-emerald-400" /> : <UploadCloud className="h-5 w-5 text-zinc-400" />}
        </div>
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-zinc-200">
            {isUploading ? 'Sedang upload…' : 'Drag & drop file di sini'}
          </p>
          <p className="text-[10px] text-zinc-500">atau klik untuk pilih file · multi-file didukung</p>
        </div>
      </button>
      <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-zinc-600">
        {Object.entries(CATEGORIES).slice(0, 3).map(([k, v]) => (
          <div key={k} className="rounded bg-zinc-900/60 px-2 py-1 text-center">
            <span className="font-medium text-zinc-500">{v.label}</span>
            <br />
            <span className="text-zinc-600">{v.hint}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
