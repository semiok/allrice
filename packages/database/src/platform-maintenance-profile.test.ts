import { execFileSync } from 'node:child_process';
import { it, expect } from 'vitest';
import { maintenanceRepositoryHarness } from './platform-maintenance-profile.ts';
it('keeps the actual staged verifier syntactically valid with a full-file manifest and explicit maintenance profile', () => {
  const harness = maintenanceRepositoryHarness();
  expect(() =>
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: harness,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  ).not.toThrow();
  expect(harness).toContain(
    'config.maintenance.verificationPlan.approvedFiles',
  );
  expect(harness).toContain('profileId:config.maintenance.profileId');
  expect(harness).toContain('version:3,compiled,verificationPlanDigest:');
});
