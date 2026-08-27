import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ConnectorBindingSchema,
  KnowledgeCitationSchema,
} from './knowledge.js';

describe('Knowledge and connector contracts', () => {
  it('keeps citations source-locatable without embedding source content', () => {
    const citation = KnowledgeCitationSchema.parse({
      type: 'knowledge',
      id: randomUUID(),
      label: '产品资料 · 片段 2',
      knowledgeRevisionId: randomUUID(),
      documentId: randomUUID(),
      sourceKind: 'workspace_files',
      scope: 'workspace',
      locator: {
        sourceRef: `file:${randomUUID()}`,
        chunk: 1,
        start: 200,
        end: 400,
      },
      updatedAt: '2026-08-25T00:00:00.000Z',
      score: 0.82,
    });
    expect(citation.locator.chunk).toBe(1);
  });

  it('prevents service identities from impersonating users', () => {
    expect(() =>
      ConnectorBindingSchema.parse({
        id: randomUUID(),
        connectorId: randomUUID(),
        identityMode: 'service',
        userId: randomUUID(),
        credentialReference: 'service:drive',
        resourceScope: {},
        enabled: true,
      }),
    ).toThrow('cannot impersonate a user');
  });
});
