import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EmployeeManifestSchema,
  PublishEmployeeVersionInputSchema,
} from './employees.js';

describe('EmployeeHub contracts', () => {
  it('accepts a Codex-backed Rice manifest with exact SkillVersion IDs', () => {
    const skillVersionId = randomUUID();
    const manifest = EmployeeManifestSchema.parse({
      schemaVersion: 1,
      key: 'default-assistant',
      name: 'Rice',
      description: 'General AI employee',
      systemPrompt: 'Act as Rice inside the authorized tenant context.',
      provider: {
        provider: 'codex',
        authMode: 'chatgpt_subscription',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        sandbox: 'workspace-write',
      },
      capabilities: ['model:invoke'],
      skillVersionIds: [skillVersionId],
    });
    expect(manifest.name).toBe('Rice');
    expect(manifest.provider.provider).toBe('codex');
    expect(manifest.skillVersionIds).toEqual([skillVersionId]);
  });

  it('rejects mutable skill aliases in a publication request', () => {
    expect(() =>
      PublishEmployeeVersionInputSchema.parse({
        workspaceId: randomUUID(),
        employeeId: randomUUID(),
        skillVersionIds: ['weather@latest'],
      }),
    ).toThrow();
  });
});
