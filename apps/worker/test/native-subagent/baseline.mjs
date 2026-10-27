/* global process */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

// Reference argument: node_modules directory of an isolated DSH 0.2.1-rc.2
// base + web installation (pnpm's flattened .pnpm/node_modules also works).
const reference = process.argv[2];
if (!reference)
  throw Error(
    'Usage: node baseline.mjs <reference-node_modules> [result.json]',
  );
const results = {};
for (const mode of ['native', 'worker']) {
  const output = execFileSync(
    process.execPath,
    [resolve(import.meta.dirname, 'baseline-host.mjs'), mode, reference],
    {
      timeout: 60000,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  results[mode] = JSON.parse(output.trim().split('\n').at(-1));
}
assert.deepEqual(results.worker, results.native);
if (process.argv[3])
  writeFileSync(process.argv[3], JSON.stringify(results, null, 2) + '\n');
process.stdout.write(
  'PASS native standard = Worker: catalog, relay, settlement, errors, list states, wait\n',
);
