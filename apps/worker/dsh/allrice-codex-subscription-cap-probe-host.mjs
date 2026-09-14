/* global process */
import { fileURLToPath, URL } from 'node:url';
import { boot } from '@deepseek-ai/dsh-app-boot';
import { runCodexSubscriptionCapProbe } from './allrice-codex-subscription-cap-probe.mjs';

// Standalone host for the SHA-authorized outer driver. The real DSH credential
// resolver owns all credential parsing. No .env loading, Codex CLI, copied
// credential store, auth refresh, Agent/session or production gate is involved.
let ctx;
let result = { outcome: 'host_opt_in_required' };
try {
  if (
    process.env.ALLRICE_CODEX_CAP_PROBE_CONFIRMATION !==
      'run-one-codex-subscription-cap-probe' ||
    !/^[a-f0-9]{40}$/.test(process.env.ALLRICE_CODEX_CAP_PROBE_SHA ?? '') ||
    !process.permission ||
    process.permission.has('fs.write') ||
    process.execArgv.some((value) => value.startsWith('--allow-fs-write'))
  ) {
    throw Error('host_scope_required');
  }
  ctx = await boot(
    'allrice-codex-subscription-cap-probe',
    fileURLToPath(
      new URL('./allrice-codex-cap-probe.cordis.yml', import.meta.url),
    ),
    [],
  );
  result = await runCodexSubscriptionCapProbe({
    confirmation: process.env.ALLRICE_CODEX_CAP_PROBE_CONFIRMATION,
    credentials: ctx.credentials,
  });
} catch {
  result = { outcome: 'host_failed', errorType: 'host_or_credential' };
} finally {
  try {
    await ctx?.root.fiber.dispose();
  } catch {
    result = { outcome: 'host_cleanup_failed', errorType: 'host_cleanup' };
  }
}
process.stdout.write(`CODEX_CAP_PROBE_RESULT=${JSON.stringify(result)}\n`);
