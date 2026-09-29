'use client'

import { useEffect, useRef, useState } from 'react'
import { Send, Square, Sparkles, User, Trash2, AlertCircle } from 'lucide-react'
import { usePlatformStore, type ChatMessage, newId } from '@/store/platform-store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const SYSTEM_PROMPT = `You are a helpful AI assistant loaded from the user's uploaded model file. Answer clearly and concisely. If the user is testing the model, demonstrate capability across reasoning, code, and instruction-following.`

export function ChatTester() {
  const messages = usePlatformStore((s) => s.chatMessages)
  const addChatMessage = usePlatformStore((s) => s.addChatMessage)
  const appendChatContent = usePlatformStore((s) => s.appendChatContent)
  const finalizeChatMessage = usePlatformStore((s) => s.finalizeChatMessage)
  const setChatStreaming = usePlatformStore((s) => s.setChatStreaming)
  const chatStreaming = usePlatformStore((s) => s.chatStreaming)
  const runState = usePlatformStore((s) => s.runState)
  const activeModel = usePlatformStore((s) => s.activeModel)
  const clearChat = usePlatformStore((s) => s.clearChat)
  const log = usePlatformStore((s) => s.log)

  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const canSend = runState === 'running' && !chatStreaming && input.trim().length > 0

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
        </div>
        <Button variant="ghost" size="sm" onClick={clearChat} className="h-7 gap-1 text-xs text-zinc-400 hover:text-zinc-200">
          <Trash2 className="h-3 w-3" /> Clear
        </Button>
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
                  ? 'Klik tombol Run di header dulu untuk load model. Setelah status berubah "running", chat ini aktif.'
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
            placeholder={runState === 'running' ? 'Ketik pesan… (Cmd/Ctrl+Enter untuk kirim)' : 'Run model dulu sebelum chat…'}
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
