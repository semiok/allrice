import { describe, expect, it } from 'vitest';

import { redactEmployeeSecrets } from './employeehub.js';

describe('EmployeeHub public serialization', () => {
  it('removes deployment Provider details recursively', () => {
    const publicValue = redactEmployeeSecrets({
      manifest: {
        runtimePolicy: {
          harness: 'dsh',
          provider: 'openai-compatible',
          model: 'MiniMax-M3',
          credentialReference: 'deployment:minimax-default',
          baseUrl: 'https://provider.example/v1',
        },
        provider: {
          provider: 'dsh',
          credentialReference: 'deployment:minimax-default',
          baseUrl: 'https://provider.example/v1',
        },
      },
    });

    expect(publicValue).toEqual({
      manifest: {
        runtimePolicy: {
          harness: 'dsh',
          provider: 'openai-compatible',
          model: 'MiniMax-M3',
        },
        provider: { provider: 'dsh' },
      },
    });
  });
});
