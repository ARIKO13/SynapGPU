import { NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { createHash } from 'crypto'

/**
 * Download the SynapGPU Desktop source code as a zip.
 *
 * Why this exists: GitHub release v0.8.0 ships a Windows .zip built from
 * the OLD source — before all the recent fixes (dashboard offline handling,
 * trained-model persistence, chat disclaimer, etc.). To get a build with the
 * fixes, the user normally has to: git push → git tag → build on Windows →
 * upload to GitHub. That's a multi-step manual flow.
 *
 * Instead, this endpoint serves the current source of `synapgpu-desktop/`
 * straight from the sandbox, zipped on-the-fly. The user can download it,
 * run `pip install -r requirements.txt && python app.py`, and have the
 * fixed Desktop app running locally within ~30 seconds.
 *
 * Note: this is source code, not a prebuilt binary. Users who want the
 * Windows .exe specifically still need to wait for a new GitHub release.
 * That's documented in the chat-tester disclaimer and the Download button
 * tooltip.
 */

// Root folder containing synapgpu-desktop source.
const DESKTOP_ROOT = path.resolve(process.cwd(), 'synapgpu-desktop')

// Files to exclude from the zip — build artifacts, caches, etc.
const EXCLUDE_PATTERNS = [
  /node_modules/i,
  /\.git/i,
  /__pycache__/i,
  /\.pyc$/i,
  /build\/$/i,
  /dist\/$/i,
  /\.spec$/i, // PyInstaller spec is for building, not running
]

interface FileEntry {
  /** Path inside the zip (POSIX-style, forward slashes). */
  archivePath: string
  /** Absolute filesystem path. */
  absPath: string
}

async function walk(dir: string, base: string, out: FileEntry[] = []): Promise<FileEntry[]> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const absPath = path.join(dir, entry)
    const relPath = path.relative(base, absPath)
    if (EXCLUDE_PATTERNS.some((p) => p.test(relPath))) continue
    let stat
    try {
      stat = await fs.stat(absPath)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      await walk(absPath, base, out)
    } else if (stat.isFile()) {
      out.push({
        archivePath: relPath.split(path.sep).join('/'),
        absPath,
      })
    }
  }
  return out
}

/**
 * Minimal ZIP file writer. We implement just enough of the PKZIP spec to
 * produce a valid .zip with no compression (STORE method) — the SynapGPU
 * Desktop source is small (~50KB total), so compression gains nothing
 * significant and skipping it avoids the `zlib` dependency.
 *
 * Each file: local header + filename + uncompressed data + (no descriptor).
 * At the end: central directory headers + EOCD record.
 *
 * Spec: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 */
function crc32(buf: Uint8Array): number {
  // Build CRC table once.
  const table = (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      t[i] = c >>> 0
    }
    return t
  })()
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff])
}
function u32(n: number): Uint8Array {
  return new Uint8Array([
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  ])
}
function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((a, b) => a + b.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

interface ZippedFile {
  /** Central directory header record. */
  centralHeader: Uint8Array
  /** Concatenated local header + filename + data. */
  localChunk: Uint8Array
}

function zipFile(archivePath: string, content: Uint8Array): ZippedFile {
  const nameBytes = new TextEncoder().encode(archivePath)
  const crc = crc32(content)
  const modDate = 0x0000 // 1980-01-00 (placeholder; zip spec allows)
  const modTime = 0x0000
  const method = 0 // STORE

  const localHeader = concat(
    u32(0x04034b50), // local file header signature
    u16(20), // version needed to extract (2.0)
    u16(0), // general purpose bit flag
    u16(method),
    u16(modTime),
    u16(modDate),
    u32(crc),
    u32(content.length), // compressed size = uncompressed for STORE
    u32(content.length), // uncompressed size
    u16(nameBytes.length),
    u16(0), // extra field length
  )
  const localChunk = concat(localHeader, nameBytes, content)

  const centralHeader = concat(
    u32(0x02014b50), // central file header signature
    u16(20), // version made by
    u16(20), // version needed
    u16(0), // general purpose flag
    u16(method),
    u16(modTime),
    u16(modDate),
    u32(crc),
    u32(content.length),
    u32(content.length),
    u16(nameBytes.length),
    u16(0), // extra field length
    u16(0), // comment length
    u16(0), // disk number start
    u16(0), // internal attributes
    u32(0), // external attributes
    u32(0), // offset of local header (we'll set this during write)
    nameBytes,
  )

  return { centralHeader, localChunk }
}

export async function GET() {
  try {
    const files = await walk(DESKTOP_ROOT, DESKTOP_ROOT)

    // Build a single README explaining what this is and how to run it.
    const readme = `# SynapGPU Desktop — Latest Source (with all fixes)

This is a snapshot of the SynapGPU Desktop source code from the live preview
sandbox, built ${new Date().toISOString()}.

## What's fixed in this build (vs. GitHub v0.8.0 release)

- Dashboard no longer stuck on "Connecting…" forever — falls back to a clear
  "Backend offline" panel after 8s if the Flask backend isn't reachable.
- Dragging & dropping a .gguf file in the sidebar now auto-selects it in the
  Test tab's model dropdown, so the user can click Load immediately.
- Test tab has two model sources: Pre-trained (existing .gguf) and Trained
  (train a new model from base + dataset).
- Training produces a downloadable manifest .json file.
- Trained model state persists across page reloads (localStorage).

## Quickstart (run from source)

\`\`\`bash
cd synapgpu-desktop
pip install -r requirements.txt
python app.py
# → open http://localhost:3000 in your browser
\`\`\`

## Build a Windows .exe yourself

\`\`\`bat
cd synapgpu-desktop
build.bat
\`\`\`

Produces dist/SynapGPU/SynapGPU.exe — distribute the entire dist/SynapGPU/
folder to end users.

## Files included
${files.map((f) => `- ${f.archivePath}`).join('\n')}
`
    files.unshift({
      archivePath: 'README-LATEST.md',
      absPath: '', // marker — we'll substitute the readme content
    })

    const zipped: ZippedFile[] = []
    let localOffset = 0
    const centralRecords: { header: Uint8Array; offset: number }[] = []

    // Add README first.
    const readmeBytes = new TextEncoder().encode(readme)
    const readmeZip = zipFile('README-LATEST.md', readmeBytes)
    centralRecords.push({ header: readmeZip.centralHeader, offset: localOffset })
    zipped.push(readmeZip)
    localOffset += readmeZip.localChunk.length

    for (const f of files.slice(1)) {
      let content: Uint8Array
      try {
        const buf = await fs.readFile(f.absPath)
        content = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      } catch {
        continue
      }
      const z = zipFile(f.archivePath, content)
      centralRecords.push({ header: z.centralHeader, offset: localOffset })
      zipped.push(z)
      localOffset += z.localChunk.length
    }

    // Patch central directory entries with their local header offsets.
    const centralWithOffsets = centralRecords.map((r) => {
      // The offset field is the last 4 bytes before the filename in the
      // central header. Our header ends with: ...offset(4 bytes) + filename.
      // Total header (without filename) is 46 bytes.
      // We need to overwrite bytes [42..46) of the header (0-indexed).
      const header = new Uint8Array(r.header)
      const offsetView = new DataView(header.buffer, 42, 4)
      offsetView.setUint32(0, r.offset, true)
      return header
    })

    const centralStart = localOffset
    let centralSize = 0
    for (const h of centralWithOffsets) centralSize += h.length

    const eocd = concat(
      u32(0x06054b50), // EOCD signature
      u16(0), // disk number
      u16(0), // disk where central dir starts
      u16(centralWithOffsets.length), // entries on this disk
      u16(centralWithOffsets.length), // total entries
      u32(centralSize),
      u32(centralStart), // offset of start of central directory
      u16(0), // comment length
    )

    // Concatenate everything.
    const allChunks: Uint8Array[] = []
    for (const z of zipped) allChunks.push(z.localChunk)
    for (const h of centralWithOffsets) allChunks.push(h)
    allChunks.push(eocd)

    const totalSize = allChunks.reduce((a, b) => a + b.length, 0)
    const result = new Uint8Array(totalSize)
    let off = 0
    for (const chunk of allChunks) {
      result.set(chunk, off)
      off += chunk.length
    }

    const dateStr = new Date().toISOString().slice(0, 10)
    const filename = `SynapGPU-Desktop-latest-${dateStr}.zip`

    return new NextResponse(result, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Length': String(totalSize),
      },
    })
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to build source zip: ${(e as Error).message}` },
      { status: 500 },
    )
  }
}
