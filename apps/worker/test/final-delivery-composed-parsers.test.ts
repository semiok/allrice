import { describe, expect, it } from 'vitest';
import { createDeliveryMarkup } from '../src/final-delivery/markup.js';
import {
  checkFinalDelivery,
  type DeliverySnapshot,
} from '../src/final-delivery/policy.js';
import { assertRuntimeFixtureDatabase } from '../../../packages/database/src/runtime-fixture-database.ts';

describe('composed parser dependencies and preserved source boundaries', () => {
  it('loads the declared Markdown/GFM stack and parses actual links inside a table', () => {
    expect(
      createDeliveryMarkup().markdown(
        '| file | value |\n| --- | --- |\n| [original](/api/v1/files/a/download) | 0 |',
      ),
    ).toMatchObject({
      type: 'root',
      children: [
        {
          type: 'table',
          children: [
            { type: 'tableRow' },
            {
              type: 'tableRow',
              children: [
                {
                  type: 'tableCell',
                  children: [{ type: 'link', url: '/api/v1/files/a/download' }],
                },
                { type: 'tableCell' },
              ],
            },
          ],
        },
      ],
    });
  });
  it('keeps quoted HTML/code destinations outside the real delivery link set', () => {
    expect(
      createDeliveryMarkup().html(
        '<code><a href="/ignored">example</a></code><a href="/kept">file</a>',
      ),
    ).toEqual({ complete: true, links: [{ href: '/kept' }] });
  });
  it('accepts only the existing two dedicated fixture URL pairs without connecting to a database', () => {
    for (const value of [
      'postgres://a123@127.0.0.1:5432/allrice_b2',
      'postgres://allrice@127.0.0.1:54329/allrice',
    ])
      expect(() => assertRuntimeFixtureDatabase(new URL(value))).not.toThrow();
    for (const value of [
      'postgres://a123@127.0.0.1:5432/allrice',
      'postgres://allrice@127.0.0.1:54329/prod',
      'postgres://allrice@example.test:54329/allrice',
    ])
      expect(() => assertRuntimeFixtureDatabase(new URL(value))).toThrow(
        'Dedicated local/CI fixture database required',
      );
  });
  it('allows an exact frozen historical reference while refusing to call it a current Run output', () => {
    const id = (n: number) =>
      '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
    const scope = {
      organizationId: id(1),
      workspaceId: id(2),
      ownerId: id(3),
      sessionId: id(4),
      runId: id(5),
    };
    const identity = {
      objectId: id(10),
      versionId: id(11),
      checksum: 'sha256:' + 'a'.repeat(64),
    };
    const snapshot: DeliverySnapshot = {
      scope,
      complete: true,
      authorization: 'current',
      now: '2026-10-20T00:00:00.000Z',
      ownedRunIds: [scope.runId],
      explicitReferenceVersionIds: [identity.versionId],
      artifacts: [
        {
          ...identity,
          scope,
          originRunId: id(20),
          fileName: 'old.xlsx',
          state: 'ready',
          immutable: true,
          deletedAt: null,
          retentionUntil: null,
        },
      ],
      checks: [],
      requirements: [],
    };
    const input = {
      candidate:
        '[historical](/api/v1/files/' + identity.objectId + '/download)',
      expectedScope: scope,
      markup: createDeliveryMarkup(),
      managedOrigins: [],
    };
    expect(checkFinalDelivery({ ...input, snapshot }).status).toBe('valid');
    const decision = checkFinalDelivery({
      ...input,
      snapshot: {
        ...snapshot,
        requirements: [
          {
            id: 'new-output',
            expected: identity,
            source: 'current_run',
            requireLink: true,
            requiredChecks: [],
          },
        ],
      },
    });
    expect(decision.status).toBe('invalid_response');
    expect(decision.issues.map((issue) => issue.code)).toContain(
      'missing_requested_artifact',
    );
    expect(snapshot.ownedRunIds).not.toContain(id(20));
    expect(snapshot.artifacts[0]!.originRunId).toBe(id(20));
  });
});
