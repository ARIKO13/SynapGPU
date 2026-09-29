import { NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

// In-memory file registry. In a real deployment this would live in the DB;
// here we keep it in process memory and reset on dev reload — which is fine
// for a single-user sandbox.
export interface FileRecord {
  id: string
  name: string
  sizeBytes: number
  category: 'llm' | 'dataset' | 'config' | 'other'
  uploadedAt: number
  // For files we actually saved to disk (small ones), the absolute path.
  savedPath?: string
}

const FILES: FileRecord[] = []

function categorize(name: string): FileRecord['category'] {
  const lower = name.toLowerCase()
  if (/\.(gguf|bin|safetensors|pt|pth|onnx|ggmf)$/.test(lower)) return 'llm'
  if (/\.(csv|jsonl?|parquet|txt|tsv|arrow)$/.test(lower)) return 'dataset'
  if (/\.(ya?ml|toml|ini|conf|json)$/.test(lower)) return 'config'
  return 'other'
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

export async function GET() {
  return NextResponse.json({
    files: FILES.map((f) => ({ ...f, humanSize: humanSize(f.sizeBytes) })),
    totalFiles: FILES.length,
    totalSizeBytes: FILES.reduce((a, f) => a + f.sizeBytes, 0),
  })
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData()
    const entries = formData.getAll('files')
    const created: FileRecord[] = []

    for (const entry of entries) {
      if (!(entry instanceof File)) continue
      const id = crypto.randomUUID()
      const record: FileRecord = {
        id,
        name: entry.name,
        sizeBytes: entry.size,
        category: categorize(entry.name),
        uploadedAt: Date.now(),
      }
      // Only persist tiny files (<5 MB) to disk — the rest are tracked as
      // metadata only. This keeps the sandbox light while still giving the
      // user real file information.
      if (entry.size <= 5 * 1024 * 1024) {
        const dir = path.join(os.tmpdir(), 'colab-gpu-uploads')
        await fs.mkdir(dir, { recursive: true })
        const dest = path.join(dir, `${id}-${entry.name}`)
        const buf = Buffer.from(await entry.arrayBuffer())
        await fs.writeFile(dest, buf)
        record.savedPath = dest
      }
      FILES.push(record)
      created.push(record)
    }

    return NextResponse.json({
      created: created.map((f) => ({ ...f, humanSize: humanSize(f.sizeBytes) })),
      files: FILES.map((f) => ({ ...f, humanSize: humanSize(f.sizeBytes) })),
      totalFiles: FILES.length,
      totalSizeBytes: FILES.reduce((a, f) => a + f.sizeBytes, 0),
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const idx = FILES.findIndex((f) => f.id === id)
  if (idx === -1) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const [removed] = FILES.splice(idx, 1)
  if (removed?.savedPath) {
    try { await fs.unlink(removed.savedPath) } catch { /* ignore */ }
  }
  return NextResponse.json({ ok: true })
}
