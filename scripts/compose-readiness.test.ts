import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const source = readFileSync('scripts/compose-smoke.sh', 'utf8');
const helper = source.match(/wait_for_proxy_ready\(\) \{[\s\S]*?\n\}/)![0];

function probe(successAt: number) {
  return spawnSync('/bin/bash', ['-s'], {
    input: `
set -eu
proxy_port=18080
calls=0
curl() {
  calls=$((calls + 1))
  [[ "$*" == *"--connect-timeout 2 --max-time 5 http://127.0.0.1:18080/api/health/ready" ]] || exit 90
  (( calls >= ${successAt} ))
}
sleep() { SECONDS=$((SECONDS + 1)); }
${helper}
if wait_for_proxy_ready; then
  printf '%s' "$calls"
else
  exit 1
fi
`,
    encoding: 'utf8',
    timeout: 3000,
  });
}

it('waits through proxy startup connection failures until readiness succeeds', () => {
  const result = probe(3);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('3');
});

it('does not delay an already ready proxy', () => {
  expect(probe(1).stdout).toBe('1');
});

it('fails with a bounded diagnostic if readiness never succeeds', () => {
  const result = probe(1000);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('did not become ready within 60 seconds');
});

it('checks readiness after initial startup and restart, before business assertions', () => {
  expect(source).toMatch(
    /up --build --wait --wait-timeout 300\n\nwait_for_proxy_ready/,
  );
  expect(source).toMatch(/restart postgres web\nwait_for_proxy_ready/);
});
