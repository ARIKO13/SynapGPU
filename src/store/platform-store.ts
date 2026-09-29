'use client'

import { create } from 'zustand'

export type FileCategory = 'llm' | 'dataset' | 'config' | 'other'

export interface FileRecord {
  id: string
  name: string
  sizeBytes: number
  humanSize: string
  category: FileCategory
  uploadedAt: number
  savedPath?: string
}

export interface Metrics {
  ts: number
  gpu: {
    utilization: number
    memoryUsedGb: number
    memoryTotalGb: number
    tempC: number
    powerW: number
  }
  ram: { usedGb: number; totalGb: number }
  ssd: {
    usedGb: number
    totalGb: number
    readMbps: number
    writeMbps: number
  }
  net: { rxMbps: number; txMbps: number }
}

export type RunState = 'idle' | 'loading' | 'running' | 'stopped' | 'error'

export interface ConsoleLine {
  id: string
  ts: number
  level: 'info' | 'warn' | 'error' | 'success'
  text: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  ts: number
  latencyMs?: number
  streaming?: boolean
}

interface PlatformState {
  // Files
  files: FileRecord[]
  isUploading: boolean
  // Run
  runState: RunState
  activeModel: string | null
  runStartedAt: number | null
  // Metrics
  metrics: Metrics | null
  metricsHistory: Metrics[]
  connected: boolean
  // Console
  consoleLines: ConsoleLine[]
  // Chat
  chatMessages: ChatMessage[]
  chatStreaming: boolean
  // Actions
  addFiles: (files: FileRecord[]) => void
  removeFile: (id: string) => void
  clearFiles: () => void
  setUploading: (v: boolean) => void
  setRunState: (s: RunState, opts?: { model?: string | null }) => void
  setMetrics: (m: Metrics) => void
  setConnected: (v: boolean) => void
  log: (text: string, level?: ConsoleLine['level']) => void
  clearConsole: () => void
  addChatMessage: (m: ChatMessage) => void
  appendChatContent: (id: string, chunk: string) => void
  finalizeChatMessage: (id: string, latencyMs?: number) => void
  setChatStreaming: (v: boolean) => void
  clearChat: () => void
}

const MAX_HISTORY = 60
const MAX_CONSOLE = 200
const MAX_CHAT = 100

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

export const usePlatformStore = create<PlatformState>((set) => ({
  files: [],
  isUploading: false,
  runState: 'idle',
  activeModel: null,
  runStartedAt: null,
  metrics: null,
  metricsHistory: [],
  connected: false,
  consoleLines: [],
  chatMessages: [],
  chatStreaming: false,

  addFiles: (files) =>
    set((s) => ({ files: [...s.files, ...files] })),
  removeFile: (id) =>
    set((s) => ({ files: s.files.filter((f) => f.id !== id) })),
  clearFiles: () => set({ files: [] }),
  setUploading: (v) => set({ isUploading: v }),

  setRunState: (runState, opts) =>
    set((s) => ({
      runState,
      activeModel: opts?.model !== undefined ? opts.model : s.activeModel,
      runStartedAt:
        runState === 'idle' || runState === 'stopped' || runState === 'error'
          ? null
          : s.runStartedAt ?? Date.now(),
    })),

  setMetrics: (m) =>
    set((s) => ({
      metrics: m,
      metricsHistory: [...s.metricsHistory, m].slice(-MAX_HISTORY),
    })),
  setConnected: (v) => set({ connected: v }),

  log: (text, level = 'info') =>
    set((s) => ({
      consoleLines: [
        ...s.consoleLines,
        { id: uid(), ts: Date.now(), level, text },
      ].slice(-MAX_CONSOLE),
    })),
  clearConsole: () => set({ consoleLines: [] }),

  addChatMessage: (m) =>
    set((s) => ({ chatMessages: [...s.chatMessages, m].slice(-MAX_CHAT) })),
  appendChatContent: (id, chunk) =>
    set((s) => ({
      chatMessages: s.chatMessages.map((m) =>
        m.id === id ? { ...m, content: m.content + chunk } : m
      ),
    })),
  finalizeChatMessage: (id, latencyMs) =>
    set((s) => ({
      chatMessages: s.chatMessages.map((m) =>
        m.id === id ? { ...m, streaming: false, latencyMs } : m
      ),
    })),
  setChatStreaming: (v) => set({ chatStreaming: v }),
  clearChat: () => set({ chatMessages: [] }),
}))

export const newId = uid
