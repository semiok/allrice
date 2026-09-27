// Offline probe of the real restricted Cordis composition; no provider request.
/* global process, console */
import { boot } from '@deepseek-ai/dsh-app-boot';
let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls++;
  throw new Error('Unexpected network destination');
};
const ctx = await boot(
  'allrice-reasoning-offline-probe',
  process.env.DSH_CORDIS_CONFIG,
);
try {
  await ctx.get('loader')?.await();
  let geminiRetired = false;
  try {
    await ctx.llm.resolveModelInfo('google', 'gemini-3.8-flash');
  } catch {
    geminiRetired = true;
  }
  const codex = await ctx.llm.resolveModelInfo(
    'openai-codex',
    process.env.DSH_CODEX_MODEL,
  );
  console.log(
    'PROBE_RESULT=' +
      JSON.stringify({ codex: codex.reasoning, geminiRetired, networkCalls }),
  );
} finally {
  await ctx.root.fiber.dispose();
}
