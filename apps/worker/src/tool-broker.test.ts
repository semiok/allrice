import { randomUUID } from 'node:crypto';

import type { ExecutionContext } from '@allrice/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recordToolBrokerAudit } = vi.hoisted(() => ({
  recordToolBrokerAudit: vi.fn(async () => undefined),
}));

vi.mock('@allrice/database', () => ({
  createAutomationFromExecutionContext: vi.fn(),
  getToolBrokerFile: vi.fn(),
  listToolBrokerFiles: vi.fn(),
  recordToolBrokerAudit,
  searchToolBrokerMemories: vi.fn(),
  searchToolBrokerSessions: vi.fn(),
}));

import {
  executeRiceTool,
  riceToolDefinitionsForCapabilities,
} from './tool-broker.js';

function executionContext(): ExecutionContext {
  const organizationId = randomUUID();
  const actorId = randomUUID();
  return {
    executionId: randomUUID(),
    runId: randomUUID(),
    jobId: randomUUID(),
    worker: { type: 'worker', id: randomUUID() },
    delegatedBy: { type: 'user', id: actorId },
    organizationId,
    workspaceId: randomUUID(),
    policySnapshot: {
      id: randomUUID(),
      organizationId,
      subjectId: actorId,
      version: 1,
      issuedAt: '2026-08-26T00:00:00.000Z',
      expiresAt: '2026-08-27T00:00:00.000Z',
      memberships: [],
      grants: [],
    },
    startedAt: '2026-08-26T00:00:00.000Z',
  };
}

describe('Codex hosted search Tool Broker integration', () => {
  beforeEach(() => recordToolBrokerAudit.mockClear());

  it('exposes search only through the outbound-network capability', () => {
    expect(
      riceToolDefinitionsForCapabilities(['network:outbound']).map(
        (tool) => tool.name,
      ),
    ).toEqual(['web.search', 'web.fetch']);
    expect(
      riceToolDefinitionsForCapabilities(['storage:read']),
    ).not.toContainEqual(expect.objectContaining({ name: 'web.search' }));
  });

  it('returns hosted search output and sources through the normalized tool result', async () => {
    const codexSearch = vi.fn(async (query: string, maxResults = 5) => ({
      provider: 'codex-hosted-search' as const,
      query,
      output: 'AllRice search summary',
      results: [
        {
          type: 'text_result',
          url: 'https://example.com/allrice',
          title: 'AllRice',
        },
      ].slice(0, maxResults),
    }));

    const result = await executeRiceTool({
      context: executionContext(),
      capabilities: ['network:outbound'],
      storageRoot: '.local/storage',
      call: {
        id: randomUUID(),
        name: 'web.search',
        arguments: { query: 'AllRice', maxResults: 3 },
      },
      codexSearch,
    });

    expect(codexSearch).toHaveBeenCalledWith('AllRice', 3);
    expect(JSON.parse(result.modelContent)).toMatchObject({
      provider: 'codex-hosted-search',
      retrievedAt: expect.any(String),
      output: 'AllRice search summary',
      sources: [{ url: 'https://example.com/allrice' }],
    });
    expect(recordToolBrokerAudit).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'web.search' }),
    );
  });
});
