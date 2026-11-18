import { NextResponse } from 'next/server'

/**
 * Training endpoint (stub).
 *
 * In a real deployment this would dispatch to a backend runner (llama.cpp
 * fine-tune, peft, etc.) and stream progress. In this sandbox we don't have
 * GPU compute or a real training pipeline — instead we simulate training
 * synchronously and return a fake trained-model artifact.
 *
 * The artifact metadata is real (name, size, params, base, dataset) so the
 * UI can display it correctly and let the user "load" it for testing via
 * /api/run.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))

  const modelId: string | undefined = body.modelId
  const datasetId: string | undefined = body.datasetId
  const epochs: number = Number(body.epochs) || 3
  const method: 'lora' | 'full' = body.method === 'full' ? 'full' : 'lora'
  const output: string = (body.output as string) || 'trained-model'

  if (!modelId || !datasetId) {
    return NextResponse.json(
      { error: 'modelId and datasetId are required' },
      { status: 400 },
    )
  }

  // Simulate training latency. Real training would take minutes-to-hours;
  // here we just sleep a bit so the UI's "Training…" spinner is visible.
  await new Promise((r) => setTimeout(r, 1200))

  // Heuristic "params" estimate — in reality you'd inspect the GGUF metadata.
  // We just pick a plausible parameter count based on method.
  const paramsB = method === 'lora' ? 0.5 : 7

  return NextResponse.json({
    ok: true,
    name: `${output}.gguf`,
    // Pretend the trained artifact is ~700 MB. The UI uses this for display
    // only — actual download isn't wired up in the web preview.
    size: 700 * 1024 * 1024,
    params_b: paramsB,
    method,
    epochs,
    note: 'Simulated training (no real compute in sandbox). Use SynapGPU Desktop for actual fine-tuning.',
    timestamp: Date.now(),
  })
}
