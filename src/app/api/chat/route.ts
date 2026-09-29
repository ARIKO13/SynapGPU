import { NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Streaming endpoint. Returns a ReadableStream of newline-delimited JSON
 * events: { type: 'token', content } | { type: 'done', latencyMs } | { type: 'error' }.
 *
 * The z-ai-web-dev-sdk's streaming mode returns raw SSE-encoded text chunks
 * (e.g. "data: {...}\n\n"). We buffer the bytes, split on newlines, strip the
 * "data: " prefix, parse each line as JSON, and forward the delta content.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const messages: ChatMessage[] = Array.isArray(body.messages) ? body.messages : []
  const thinkingEnabled: boolean = !!body.thinking

  if (messages.length === 0) {
    return NextResponse.json({ error: 'messages required' }, { status: 400 })
  }

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const stream = new ReadableStream({
    async start(controller) {
      const startedAt = Date.now()
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))

      try {
        const zai = await ZAI.create()
        const completion = await zai.chat.completions.create({
          messages,
          // @ts-expect-error SDK type allows this optional field.
          thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
          stream: true,
        } as Parameters<typeof zai.chat.completions.create>[0])

        // The SDK returns an AsyncIterable whose chunks are SSE-encoded text
        // (or Buffers). Buffer them, split on newlines, and parse each "data:"
        // line as a JSON chat-completion chunk.
        let buffer = ''
        let producedTokens = 0

        for await (const chunk of completion as AsyncIterable<unknown>) {
          let text: string
          if (typeof chunk === 'string') {
            text = chunk
          } else if (chunk instanceof Uint8Array) {
            text = decoder.decode(chunk, { stream: true })
          } else if (Buffer.isBuffer(chunk)) {
            text = chunk.toString('utf8')
          } else if (typeof chunk === 'object' && chunk !== null) {
            // Some SDKs return objects that look like {0:100,1:97,...} (a
            // byte container). Reassemble into a string.
            const obj = chunk as Record<string, number>
            const nums = Object.values(obj)
            if (nums.length > 0 && typeof nums[0] === 'number') {
              text = String.fromCharCode(...nums.map((n) => n & 0xff))
            } else {
              // Already-parsed object — try the standard OpenAI shape.
              const token = (chunk as { choices?: Array<{ delta?: { content?: string } }> })
                ?.choices?.[0]?.delta?.content
              if (token) {
                send({ type: 'token', content: token })
                producedTokens++
              }
              continue
            }
          } else {
            continue
          }

          buffer += text
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const evt = JSON.parse(payload)
              const token = evt?.choices?.[0]?.delta?.content
              if (token) {
                send({ type: 'token', content: token })
                producedTokens++
              }
            } catch {
              // ignore malformed lines (could be partial JSON in a chunk)
            }
          }
        }

        // Flush any remaining buffer.
        if (buffer.trim()) {
          const trimmed = buffer.trim()
          if (trimmed.startsWith('data:')) {
            const payload = trimmed.slice(5).trim()
            if (payload && payload !== '[DONE]') {
              try {
                const evt = JSON.parse(payload)
                const token = evt?.choices?.[0]?.delta?.content
                if (token) {
                  send({ type: 'token', content: token })
                  producedTokens++
                }
              } catch { /* ignore */ }
            }
          }
        }

        // Fallback: if streaming produced nothing, try a non-streaming call.
        // (Some providers' streaming endpoints can return an empty stream
        // when the prompt is too short or filtered.)
        if (producedTokens === 0) {
          const fallback = await zai.chat.completions.create({
            messages,
            // @ts-expect-error optional field
            thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
          } as Parameters<typeof zai.chat.completions.create>[0])
          const content = (fallback as { choices?: Array<{ message?: { content?: string } }> })
            ?.choices?.[0]?.message?.content
          if (content) {
            send({ type: 'token', content })
            producedTokens++
          }
        }

        send({
          type: 'done',
          latencyMs: Date.now() - startedAt,
          tokens: producedTokens,
          ts: Date.now(),
        })
      } catch (err) {
        send({ type: 'error', message: (err as Error).message })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache, no-transform',
    },
  })
}
