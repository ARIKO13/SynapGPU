import ZAI from 'z-ai-web-dev-sdk'

const zai = await ZAI.create()

// Test 1: non-streaming
console.log('--- Test 1: non-streaming ---')
const completion = await zai.chat.completions.create({
  messages: [
    { role: 'user', content: 'Say "hello world" in one sentence.' }
  ],
  thinking: { type: 'disabled' },
} as any)

console.log('Type of completion:', typeof completion)
console.log('Has Symbol.asyncIterator:', typeof (completion as any)[Symbol.asyncIterator])
console.log('Has choices:', 'choices' in (completion as any))
console.log('completion keys:', Object.keys(completion as any))
console.log('completion:', JSON.stringify(completion, null, 2).slice(0, 500))

// Test 2: streaming
console.log('\n--- Test 2: streaming ---')
const stream = await zai.chat.completions.create({
  messages: [
    { role: 'user', content: 'Say "hello world" in one sentence.' }
  ],
  thinking: { type: 'disabled' },
  stream: true,
} as any)

console.log('Type of stream:', typeof stream)
console.log('Has Symbol.asyncIterator:', typeof (stream as any)[Symbol.asyncIterator])
let tokenCount = 0
if (stream && typeof (stream as any)[Symbol.asyncIterator] === 'function') {
  for await (const chunk of stream as any) {
    tokenCount++
    if (tokenCount <= 3) console.log(`chunk ${tokenCount}:`, JSON.stringify(chunk).slice(0, 200))
  }
  console.log(`Total chunks: ${tokenCount}`)
} else {
  console.log('Stream is not async iterable, raw:', JSON.stringify(stream, null, 2).slice(0, 500))
}
