import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatFlowPage from './page';

vi.mock('./chatflow-client', () => ({ ChatFlowClient: () => null }));

describe('ChatFlow server local command capability', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['0', '0', '0', false],
    ['1', '0', '1', false],
    ['1', '1', '0', false],
    ['0', '1', '1', false],
    ['1', '1', '1', true],
  ])(
    'uses the same three flags as the API (%s/%s/%s)',
    (command, policy, ledger, enabled) => {
      vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', command);
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', policy);
      vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', ledger);
      expect(ChatFlowPage().props.localCommandsEnabled).toBe(enabled);
    },
  );
});
