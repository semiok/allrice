/** Read the existing AllRice binding via its normal credential service. No
 * generation, credential export, account refresh, purchase or quota reset. */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { probeDshCodexProvider } from '../../../apps/worker/src/codex-auth-broker.ts';
import { authorizedP27CodexPlatformHome } from './p27-codex-worker-preflight.ts';

if (process.argv.slice(2).join(' ') !== '--read')
  throw Error('explicit_read_required');
await authorizedP27CodexPlatformHome(process.env.ALLRICE_DSH_PLATFORM_HOME);
if (!process.env.ALLRICE_CODEX_QUOTA_COMMAND?.startsWith('/'))
  throw Error('explicit_quota_binary_required');
const temporary = await mkdtemp(join(tmpdir(), 'allrice-p27-quota-read-'));
let status;
try {
  status = await probeDshCodexProvider(temporary);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const root = fileURLToPath(new URL('../../../', import.meta.url));
const receipt = {
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  provider: status.provider,
  checkedAt: status.checkedAt,
  quota: status.quota ?? null,
  modelCalls: 0,
  temporaryRemoved: true,
};
const evidenceRoot = join(root, '.local');
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidencePath = join(evidenceRoot, `p27-codex-quota-${randomUUID()}.json`);
await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`, {
  mode: 0o600,
  flag: 'wx',
});
process.stdout.write(
  `${JSON.stringify({ ...receipt, evidencePath }, null, 2)}\n`,
);
