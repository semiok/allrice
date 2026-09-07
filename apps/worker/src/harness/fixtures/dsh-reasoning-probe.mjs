// Offline probe of the real Cordis composition and pi-ai wire conversion.
/* global Response, Request, process, console */
import { boot } from '@deepseek-ai/dsh-app-boot';

let wire;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://generativelanguage.googleapis.com/'))
    throw new Error('Unexpected network destination');
  wire = JSON.parse(input instanceof Request ? await input.text() : init.body);
  return new Response(
    `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'synthetic' }] }, finishReason: 'STOP' }] })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
};
const ctx = await boot(
  'allrice-reasoning-offline-probe',
  process.env.DSH_CORDIS_CONFIG,
);
try {
  await ctx.get('loader')?.await();
  const gemini = await ctx.llm.resolveModelInfo(
    'google',
    process.env.DSH_GEMINI_MODEL,
  );
  const codex = await ctx.llm.resolveModelInfo(
    'openai-codex',
    process.env.DSH_CODEX_MODEL,
  );
  const chunks = [];
  for await (const chunk of ctx.llm.stream({
    provider: 'google',
    model: process.env.DSH_GEMINI_MODEL,
    messages: [
      { role: 'user', content: [{ kind: 'text', text: 'synthetic' }] },
    ],
  })) {
    chunks.push(chunk);
  }
  console.log(
    'PROBE_RESULT=' +
      JSON.stringify({
        gemini: gemini.reasoning,
        codex: codex.reasoning,
        thinking: wire?.generationConfig?.thinkingConfig,
        wire,
        chunks,
      }),
  );
} finally {
  await ctx.root.fiber.dispose();
}
