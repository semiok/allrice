import { afterEach, expect, it, vi } from 'vitest';
import { listEmployeeToolAvailability } from './employee-administration.ts';
afterEach(() => vi.unstubAllEnvs());
it('does not advertise development as released with only generic assistants enabled', () => {
  vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
  vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
  vi.stubEnv('ALLRICE_CHANGESET_ENABLED', '0');
  const tool = () =>
    listEmployeeToolAvailability().find(
      (t) => t.canonicalName === 'assistant.development',
    )!;
  expect(tool().released).toBe(false);
  vi.stubEnv('ALLRICE_CHANGESET_ENABLED', '1');
  // Changeset also requires runtime policy and ledger, exactly as execution does.
  vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
  vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', '1');
  expect(tool().released).toBe(true);
  expect(tool().policyActions).toContain('assistant.delegate');
  vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '0');
  expect(tool().released).toBe(false);
});
