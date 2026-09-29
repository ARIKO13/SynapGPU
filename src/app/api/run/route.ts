import { NextResponse } from 'next/server'

// In a real deployment this would dispatch to a backend runner that actually
// loads the model and serves inference. In this sandbox we just record the
// intent — the actual telemetry stream is driven by the metrics mini-service.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const action: 'start' | 'stop' = body.action ?? 'start'
  const model = body.model ?? null

  // We don't directly mutate the metrics service's state from here (different
  // process). The frontend forwards run:start / run:stop over the WebSocket
  // connection — that's the source of truth for telemetry. This endpoint
  // exists so that a future real backend can be slotted in without changing
  // the UI.
  return NextResponse.json({
    ok: true,
    action,
    model,
    timestamp: Date.now(),
    note:
      action === 'start'
        ? 'Run dispatched. Telemetry will reflect loading → running transitions.'
        : 'Stop dispatched. Telemetry will decay to idle.',
  })
}
