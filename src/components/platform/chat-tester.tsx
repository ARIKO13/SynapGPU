'use client'

import { useEffect, useRef, useState } from 'react'
import { Send, Square, Sparkles, User, Trash2, AlertCircle, Cpu, Database, Download, Loader2, Play } from 'lucide-react'
import { usePlatformStore, type ChatMessage, type FileRecord, newId } from '@/store/platform-store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const SYSTEM_PROMPT = `You are a helpful AI assistant loaded from the user's uploaded model file. Answer clearly and concisely. If the user is testing the model, demonstrate capability across reasoning, code, and instruction-following.`

type LoaderMode = 'pretrained' | 'trained'

interface TrainedModel {
  name: string
  sizeBytes: number
  paramsB: number
  base: string
  dataset: string
  epochs: number
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

export function ChatTester() {
  const messages = usePlatformStore((s) => s.chatMessages)
  const addChatMessage = usePlatformStore((s) => s.addChatMessage)
  const appendChatContent = usePlatformStore((s) => s.appendChatContent)
  const finalizeChatMessage = usePlatformStore((s) => s.finalizeChatMessage)
  const setChatStreaming = usePlatformStore((s) => s.setChatStreaming)
  const chatStreaming = usePlatformStore((s) => s.chatStreaming)
  const runState = usePlatformStore((s) => s.runState)
  const activeModel = usePlatformStore((s) => s.activeModel)
  const setRunState = usePlatformStore((s) => s.setRunState)
  const clearChat = usePlatformStore((s) => s.clearChat)
  const log = usePlatformStore((s) => s.log)
  const files = usePlatformStore((s) => s.files)

  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<LoaderMode>('pretrained')
  const [selectedModelId, setSelectedModelId] = useState<string>('')
  const [trainedModel, setTrainedModel] = useState<TrainedModel | null>(null)
  const [isTraining, setIsTraining] = useState(false)
  const [trainParams, setTrainParams] = useState({
    datasetId: '',
    epochs: 3,
    lr: '1e-4',
    batch: 4,
    method: 'lora' as 'lora' | 'full',
    outputName: 'trained-model',
  })
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const llmFiles = files.filter((f) => f.category === 'llm')
  const datasetFiles = files.filter((f) => f.category === 'dataset')

  // Auto-select: when a new .gguf is dropped into the sidebar, pre-select it
  // in the Pre-trained dropdown so the user can click Load immediately.
  useEffect(() => {
    if (mode !== 'pretrained') return
    if (selectedModelId && llmFiles.some((f) => f.id === selectedModelId)) return
    const latestLlm = llmFiles[llmFiles.length - 1]
    if (latestLlm) setSelectedModelId(latestLlm.id)
  }, [llmFiles, mode, selectedModelId])

  // Auto-select dataset when a new dataset file is dropped.
  useEffect(() => {
    if (trainParams.datasetId && datasetFiles.some((f) => f.id === trainParams.datasetId)) return
    const latestDs = datasetFiles[datasetFiles.length - 1]
    if (latestDs) setTrainParams((p) => ({ ...p, datasetId: latestDs.id }))
  }, [datasetFiles, trainParams.datasetId])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const canLoadPretrained = !!selectedModelId && runState !== 'loading'
  const canStartTrain = !!selectedModelId && !!trainParams.datasetId && !isTraining

  const canSend = runState === 'running' && !chatStreaming && input.trim().length > 0

  async function loadPretrained() {
    const file = llmFiles.find((f) => f.id === selectedModelId)
    if (!file) return
    setRunState('loading', { model: file.name })
    log(`Memuat model pre-trained: ${file.name}`, 'info')
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', model: file.name }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      log(`Model ${file.name} siap untuk inference.`, 'success')
    } catch (e) {
      log(`Gagal load model: ${(e as Error).message}`, 'error')
      setRunState('error')
    }
  }

  async function startTraining() {
    const baseFile = llmFiles.find((f) => f.id === selectedModelId)
    const dsFile = datasetFiles.find((f) => f.id === trainParams.datasetId)
    if (!baseFile || !dsFile) return
    setIsTraining(true)
    log(`Mulai training ${trainParams.method.toUpperCase()} pada ${baseFile.name} dengan dataset ${dsFile.name}…`, 'info')
    try {
      const res = await fetch('/api/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: baseFile.id,
          datasetId: dsFile.id,
          epochs: trainParams.epochs,
          lr: trainParams.lr,
          batch: trainParams.batch,
          method: trainParams.method,
          output: trainParams.outputName,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const trained: TrainedModel = {
        name: data.name ?? `${trainParams.outputName}.gguf`,
        sizeBytes: data.size ?? 0,
        paramsB: data.params_b ?? 0,
        base: baseFile.name,
        dataset: dsFile.name,
        epochs: trainParams.epochs,
      }
      setTrainedModel(trained)
      log(`Training selesai: ${trained.name} (${trained.paramsB}B params)`, 'success')
    } catch (e) {
      log(`Training error: ${(e as Error).message}`, 'error')
    } finally {
      setIsTraining(false)
    }
  }

  async function loadTrained() {
    if (!trainedModel) return
    setRunState('loading', { model: trainedModel.name })
    log(`Memuat model hasil training: ${trainedModel.name}`, 'info')
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', model: trainedModel.name }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      log(`Model ${trainedModel.name} siap untuk inference.`, 'success')
    } catch (e) {
      log(`Gagal load model: ${(e as Error).message}`, 'error')
      setRunState('error')
    }
  }

  async function send() {
    if (!canSend) return
    const userMsg: ChatMessage = {
      id: newId(),
      role: 'user',
      content: input.trim(),
      ts: Date.now(),
    }
    const assistantId = newId()
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      ts: Date.now(),
      streaming: true,
    }
    addChatMessage(userMsg)
    addChatMessage(assistantMsg)
    setInput('')
    setError(null)
    setChatStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const history = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }))
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...history,
            { role: 'user', content: userMsg.content },
          ],
          thinking: false,
        }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const evt = JSON.parse(line)
            if (evt.type === 'token') appendChatContent(assistantId, evt.content)
            else if (evt.type === 'done') finalizeChatMessage(assistantId, evt.latencyMs)
            else if (evt.type === 'error') {
              setError(evt.message)
              finalizeChatMessage(assistantId)
            }
          } catch {
            // skip malformed lines
          }
        }
      }
      log(`Chat response complete.`, 'success')
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        log('Chat dibatalkan oleh user.', 'warn')
      } else {
        setError((e as Error).message)
        log(`Chat error: ${(e as Error).message}`, 'error')
      }
      finalizeChatMessage(assistantId)
    } finally {
      setChatStreaming(false)
      abortRef.current = null
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/40 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-emerald-400" />
          <span className="text-sm font-medium text-zinc-200">LLM Test Console</span>
          {activeModel && (
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
              {activeModel}
            </span>
          )}
          {runState === 'loading' && (
            <span className="flex items-center gap-1 text-[10px] text-amber-400">
              <Loader2 className="h-3 w-3 animate-spin" /> loading…
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={clearChat} className="h-7 gap-1 text-xs text-zinc-400 hover:text-zinc-200">
          <Trash2 className="h-3 w-3" /> Clear
        </Button>
      </div>

      {/* Model loader panel — Pre-trained vs Trained */}
      <div className="border-b border-zinc-800 bg-zinc-950/60 p-3">
        <div className="mb-2 flex items-center gap-1 rounded-lg bg-zinc-900/60 p-1">
          <button
            onClick={() => setMode('pretrained')}
            className={cn(
              'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition',
              mode === 'pretrained'
                ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-500/30'
                : 'text-zinc-400 hover:text-zinc-200',
            )}
          >
            <Cpu className="mr-1 inline-block h-3 w-3" /> Pre-trained Model
          </button>
          <button
            onClick={() => setMode('trained')}
            className={cn(
              'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition',
              mode === 'trained'
                ? 'bg-cyan-500/15 text-cyan-300 ring-1 ring-inset ring-cyan-500/30'
                : 'text-zinc-400 hover:text-zinc-200',
            )}
          >
            <Database className="mr-1 inline-block h-3 w-3" /> Trained Model
          </button>
        </div>

        {mode === 'pretrained' ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <select
                value={selectedModelId}
                onChange={(e) => setSelectedModelId(e.target.value)}
                disabled={llmFiles.length === 0}
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-950/80 px-3 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
              >
                {llmFiles.length === 0 ? (
                  <option value="">Drop .gguf file di sidebar kiri ↑</option>
                ) : (
                  <>
                    <option value="">Pilih model…</option>
                    {llmFiles.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name} ({f.humanSize})
                      </option>
                    ))}
                  </>
                )}
              </select>
              <Button
                onClick={loadPretrained}
                disabled={!canLoadPretrained}
                size="sm"
                className="gap-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40"
              >
                {runState === 'loading' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                Load
              </Button>
            </div>
            <p className="text-[10px] text-zinc-600">
              Pilih file .gguf dari sidebar. Setelah di-drop, otomatis terpilih di sini.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Training config */}
            {!trainedModel && (
              <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Training Config</div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1">
                    <span className="text-[10px] text-zinc-500">Base model</span>
                    <select
                      value={selectedModelId}
                      onChange={(e) => setSelectedModelId(e.target.value)}
                      disabled={llmFiles.length === 0}
                      className="w-full rounded border border-zinc-700 bg-zinc-950/80 px-2 py-1 text-[11px] text-zinc-200 disabled:opacity-50"
                    >
                      <option value="">Pilih…</option>
                      {llmFiles.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-zinc-500">Dataset</span>
                    <select
                      value={trainParams.datasetId}
                      onChange={(e) => setTrainParams((p) => ({ ...p, datasetId: e.target.value }))}
                      disabled={datasetFiles.length === 0}
                      className="w-full rounded border border-zinc-700 bg-zinc-950/80 px-2 py-1 text-[11px] text-zinc-200 disabled:opacity-50"
                    >
                      <option value="">Pilih…</option>
                      {datasetFiles.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-zinc-500">Epochs</span>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={trainParams.epochs}
                      onChange={(e) => setTrainParams((p) => ({ ...p, epochs: parseInt(e.target.value) || 1 }))}
                      className="w-full rounded border border-zinc-700 bg-zinc-950/80 px-2 py-1 text-[11px] text-zinc-200"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-zinc-500">Method</span>
                    <select
                      value={trainParams.method}
                      onChange={(e) => setTrainParams((p) => ({ ...p, method: e.target.value as 'lora' | 'full' }))}
                      className="w-full rounded border border-zinc-700 bg-zinc-950/80 px-2 py-1 text-[11px] text-zinc-200"
                    >
                      <option value="lora">LoRA</option>
                      <option value="full">Full Fine-tune</option>
                    </select>
                  </label>
                </div>
                <Button
                  onClick={startTraining}
                  disabled={!canStartTrain}
                  size="sm"
                  className="w-full gap-1 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40"
                >
                  {isTraining ? <Loader2 className="h-3 w-3 animate-spin" /> : <Database className="h-3 w-3" />}
                  {isTraining ? 'Training…' : 'Start Training'}
                </Button>
              </div>
            )}

            {/* Trained model info */}
            {trainedModel && (
              <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">Trained Model Ready</div>
                  <button
                    onClick={() => setTrainedModel(null)}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300"
                  >
                    Train lagi
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1 text-[11px]">
                  <div><span className="text-zinc-500">Name:</span> <span className="text-zinc-200">{trainedModel.name}</span></div>
                  <div><span className="text-zinc-500">Params:</span> <span className="text-zinc-200">{trainedModel.paramsB}B</span></div>
                  <div><span className="text-zinc-500">Size:</span> <span className="text-zinc-200">{humanSize(trainedModel.sizeBytes)}</span></div>
                  <div><span className="text-zinc-500">Epochs:</span> <span className="text-zinc-200">{trainedModel.epochs}</span></div>
                  <div className="col-span-2 truncate"><span className="text-zinc-500">Base:</span> <span className="text-zinc-200">{trainedModel.base}</span></div>
                  <div className="col-span-2 truncate"><span className="text-zinc-500">Dataset:</span> <span className="text-zinc-200">{trainedModel.dataset}</span></div>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    onClick={loadTrained}
                    disabled={runState === 'loading'}
                    size="sm"
                    className="flex-1 gap-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40"
                  >
                    {runState === 'loading' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                    Load & Test
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1 border-zinc-700 bg-zinc-900/60"
                    onClick={() => log('Download model: not wired up in web preview. Run Flask desktop for real download.', 'warn')}
                  >
                    <Download className="h-3 w-3" /> Download
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-zinc-950/40 p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="rounded-full border border-zinc-800 bg-zinc-900 p-4">
              <Sparkles className="h-6 w-6 text-emerald-400" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-zinc-300">Test LLM yang sudah di-load</p>
              <p className="max-w-md text-xs text-zinc-500">
                {runState !== 'running'
                  ? 'Pilih model di panel atas (Pre-trained atau Trained), klik Load, lalu chat di sini.'
                  : 'Ketik pesan dan tekan Cmd/Ctrl+Enter atau klik tombol kirim. Response stream token-by-token.'}
              </p>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {['Jelaskan apa itu WebGPU', 'Tulis fungsi Python quicksort', 'Berikan 5 ide nama startup AI'].map((s) => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  className="rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-emerald-500/40 hover:text-emerald-300"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((m) => (
              <div key={m.id} className={cn('flex gap-3', m.role === 'user' ? 'flex-row-reverse' : '')}>
                <div
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border',
                    m.role === 'user'
                      ? 'border-zinc-700 bg-zinc-800 text-zinc-300'
                      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
                  )}
                >
                  {m.role === 'user' ? <User className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                </div>
                <div className={cn('max-w-[80%] space-y-1', m.role === 'user' ? 'items-end' : '')}>
                  <div
                    className={cn(
                      'rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                      m.role === 'user'
                        ? 'bg-emerald-600 text-white rounded-tr-sm'
                        : 'border border-zinc-800 bg-zinc-900 text-zinc-200 rounded-tl-sm',
                    )}
                  >
                    {m.content || (m.streaming ? <span className="animate-pulse text-zinc-500">memikirkan…</span> : '')}
                    {m.streaming && m.content && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-emerald-400 align-middle" />}
                  </div>
                  {m.latencyMs && (
                    <div className="text-[10px] text-zinc-600">{(m.latencyMs / 1000).toFixed(2)}s</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="border-t border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-zinc-800 bg-zinc-900/60 p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={runState === 'running' ? 'Ketik pesan… (Cmd/Ctrl+Enter untuk kirim)' : 'Load model dulu sebelum chat…'}
            disabled={runState !== 'running'}
            rows={2}
            className="flex-1 resize-none border-zinc-700 bg-zinc-950/60 text-sm focus-visible:ring-emerald-500/40"
          />
          {chatStreaming ? (
            <Button onClick={stop} variant="destructive" size="icon" className="h-10 w-10 shrink-0">
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              onClick={send}
              disabled={!canSend}
              size="icon"
              className="h-10 w-10 shrink-0 bg-emerald-600 hover:bg-emerald-500"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="mt-2 text-[10px] text-zinc-600">
          Powered by z-ai-web-dev-sdk · Streaming response · Token-by-token display
        </p>
      </div>
    </div>
  )
}
