import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ChatFlowEventEnvelope } from '@allrice/contracts';

import {
  hasBrowserWorkspaceEvents,
  hasManagedBrowserEvents,
  safeBrowserHost,
} from './managed-browser-task-presenter';

function event(
  type: ChatFlowEventEnvelope['type'],
  payload: Record<string, unknown>,
  sourcePayload: Record<string, unknown> = {},
): ChatFlowEventEnvelope {
  const runId = '00000000-0000-4000-8000-000000000004';
  return {
    schemaVersion: 3,
    eventId: randomUUID(),
    organizationId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    conversationId: '00000000-0000-4000-8000-000000000003',
    runId,
    generation: 0,
    cursor: `${runId}:1`,
    sequence: 1,
    harness: 'dsh',
    type,
    occurredAt: '2026-08-31T00:00:00.000Z',
    sourceEvent: {
      id: 'dsh:1',
      type: 'session.event',
      occurredAt: '2026-08-31T00:00:00.000Z',
      payload: sourcePayload,
    },
    payload,
  };
}

describe('managed browser task presentation', () => {
  it('opens the shared workspace for cloud and local canonical/native events, never legacy tool output text', () => {
    for (const name of ['browser.workspace', 'local.browser.workspace']) {
      expect(hasBrowserWorkspaceEvents([event('tool.started', { name })])).toBe(
        true,
      );
      expect(
        hasBrowserWorkspaceEvents([event('harness.native', { label: name })]),
      ).toBe(true);
      expect(
        hasBrowserWorkspaceEvents([
          event('harness.native', {}, { toolName: name }),
        ]),
      ).toBe(true);
    }
    expect(
      hasBrowserWorkspaceEvents([
        event('tool.completed', {
          name: 'browser.run',
          text: 'local.browser.workspace',
        }),
      ]),
    ).toBe(false);
    expect(
      hasBrowserWorkspaceEvents([
        event('assistant.text.completed', { text: 'browser.workspace' }),
      ]),
    ).toBe(false);
  });
  it('detects canonical and native DSH browser tool events', () => {
    expect(
      hasManagedBrowserEvents([
        event('tool.started', { toolCallId: 'browser-1', name: 'browser.run' }),
      ]),
    ).toBe(true);
    expect(
      hasManagedBrowserEvents([
        event(
          'harness.native',
          { presentation: 'tool', label: 'browser.run' },
          { toolName: 'browser.run' },
        ),
      ]),
    ).toBe(true);
    expect(
      hasManagedBrowserEvents([
        event('tool.completed', { toolCallId: 'search-1', name: 'web.search' }),
      ]),
    ).toBe(false);
  });

  it('projects only the hostname and never leaks URL path or query values', () => {
    expect(
      safeBrowserHost(
        'https://reports.example.com/private/path?token=secret#section',
      ),
    ).toBe('reports.example.com');
    expect(safeBrowserHost('not a url')).toBeNull();
  });
});
