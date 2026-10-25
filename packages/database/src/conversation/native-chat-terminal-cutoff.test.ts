import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nativeRootDigest } from './native-root-origin.ts';
import {
  NativeChatTerminalCutoffPlanSchema,
  NativeChatAbandonedDescendantCutoffPlanSchema,
  NativeTerminalTestPlanSchema,
  nativeTerminalTestPhysicalScope,
} from './native-terminal-test-retirement.ts';

/** Pure contract tests. No getDatabase, SDK, native process or filesystem write. */
function fixture() {
  const scope = {
    contextKind: 'chat' as const,
    contextId: randomUUID(),
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
  };
  const artifactId = nativeRootDigest('old implicit executor');
  const body = {
    schemaVersion: 2 as const,
    kind: 'development-test-chat-terminal-cutoff' as const,
    requestId: randomUUID(),
    authorizationEvidenceDigest: nativeRootDigest('exact QA authorization'),
    snapshots: [
      {
        scope,
        source: { created_at: '2026-09-01T00:00:00Z' },
        origin: null,
        bindings: [],
        runIds: [randomUUID()],
        missingRunIds: [],
        missingJobIds: [],
        runs: [],
        jobs: [],
        closeRows: [],
        consumers: [],
        occurrence: null,
        preserved: {},
      },
    ],
    legacyExecutors: [
      {
        scope,
        artifactId,
        storageNamespace: `/old-native/${scope.organizationId}/${scope.workspaceId}/${scope.ownerId}/${scope.contextId}/sessions`,
      },
    ],
  };
  return { ...body, digest: nativeRootDigest(body) };
}
const signed = (p: ReturnType<typeof fixture>) => {
  const body = Object.fromEntries(
    Object.entries(p).filter(([key]) => key !== 'digest'),
  );
  return { ...p, digest: nativeRootDigest(body) };
};
describe('explicit historical terminal chat cutoff contract', () => {
  function abandonedFixture() {
    const original = fixture(),
      snapshot = original.snapshots[0]!,
      root = snapshot.runIds[0]!;
    const abandonment = {
      scope: snapshot.scope,
      rootRunIds: [root],
      descendants: [
        {
          runId: randomUUID(),
          rootRunId: root,
          parentRunId: root,
          delegationId: randomUUID(),
        },
      ],
      preservedUnfinishedAdmissionIds: [] as string[],
    };
    const body = {
      schemaVersion: 3 as const,
      kind: 'development-test-chat-abandoned-descendant-cutoff' as const,
      requestId: original.requestId,
      authorizationEvidenceDigest: original.authorizationEvidenceDigest,
      snapshots: [
        {
          ...snapshot,
          abandonment,
          unfinishedAdmissions: [] as Record<string, string>[],
        },
      ],
      abandonedScopes: [abandonment],
      legacyExecutors: original.legacyExecutors,
    };
    return { ...body, digest: nativeRootDigest(body) };
  }
  const signAbandoned = (p: ReturnType<typeof abandonedFixture>) => {
    const body = Object.fromEntries(
      Object.entries(p).filter(([key]) => key !== 'digest'),
    );
    return { ...p, digest: nativeRootDigest(body) };
  };
  it('requires a separately named schema3 arm while v1/v2 remain strict', () => {
    const p = abandonedFixture();
    expect(NativeChatAbandonedDescendantCutoffPlanSchema.parse(p)).toEqual(p);
    expect(() => NativeChatTerminalCutoffPlanSchema.parse(p)).toThrow();
    expect(() => NativeTerminalTestPlanSchema.parse(p)).toThrow();
    expect(() =>
      NativeChatAbandonedDescendantCutoffPlanSchema.parse({
        ...p,
        schemaVersion: 2,
      }),
    ).toThrow();
    expect(() =>
      NativeChatAbandonedDescendantCutoffPlanSchema.parse({
        ...p,
        kind: 'development-test-chat-terminal-cutoff',
      }),
    ).toThrow();
    expect(nativeTerminalTestPhysicalScope(p).storageNamespaces).toEqual([
      p.legacyExecutors[0]!.storageNamespace,
    ]);
  });
  it('rejects mismatched declared graph scopes even under a valid new plan digest', () => {
    const p = abandonedFixture();
    p.abandonedScopes = structuredClone(p.abandonedScopes);
    p.abandonedScopes[0]!.descendants[0]!.parentRunId = randomUUID();
    expect(() => nativeTerminalTestPhysicalScope(signAbandoned(p))).toThrow(
      'NATIVE_CHAT_ABANDONED_DECLARATION_CHANGED',
    );
  });
  it('requires the exact unfinished admission identities rather than silently omitting financial uncertainty', () => {
    const p = abandonedFixture();
    p.snapshots[0]!.unfinishedAdmissions = [{ call_id: randomUUID() }];
    expect(() => nativeTerminalTestPhysicalScope(signAbandoned(p))).toThrow(
      'NATIVE_CHAT_ABANDONED_DECLARATION_CHANGED',
    );
  });
  it('cannot replace physical namespace coverage with a schema3 graph declaration', () => {
    const p = abandonedFixture();
    p.legacyExecutors = [];
    expect(() => nativeTerminalTestPhysicalScope(signAbandoned(p))).toThrow();
  });
  it('keeps chat v1/nonchat plans strict and uses a separate v2 kind', () => {
    const p = fixture();
    expect(NativeChatTerminalCutoffPlanSchema.parse(p)).toEqual(p);
    expect(() =>
      NativeTerminalTestPlanSchema.parse({
        ...p,
        schemaVersion: 1,
        kind: 'development-terminal-test-retirement',
      }),
    ).toThrow();
    expect(() =>
      NativeChatTerminalCutoffPlanSchema.parse({ ...p, schemaVersion: 1 }),
    ).toThrow();
    expect(() =>
      NativeChatTerminalCutoffPlanSchema.parse({
        ...p,
        kind: 'development-test-chat-retirement',
      }),
    ).toThrow();
  });
  it('requires the exact implicit executor and full namespace even with no binding', () => {
    const p = fixture(),
      s = nativeTerminalTestPhysicalScope(p);
    expect(s.scopes).toEqual(p.snapshots.map((x) => x.scope));
    expect(s.artifactIds).toEqual([p.legacyExecutors[0]!.artifactId]);
    expect(s.storageNamespaces).toEqual([
      p.legacyExecutors[0]!.storageNamespace,
    ]);
  });
  it('rejects a changed signed body', () => {
    const p = fixture();
    p.snapshots[0]!.source.created_at = '2026-09-02T00:00:00Z';
    expect(() => nativeTerminalTestPhysicalScope(p)).toThrow(
      'NATIVE_TERMINAL_PLAN_CHANGED',
    );
  });
  for (const [name, change] of [
    [
      'executor omitted',
      (p: ReturnType<typeof fixture>) => {
        p.legacyExecutors = [];
      },
    ],
    [
      'scope mismatch',
      (p: ReturnType<typeof fixture>) => {
        p.legacyExecutors[0]!.scope = {
          ...p.legacyExecutors[0]!.scope,
          ownerId: randomUUID(),
        };
      },
    ],
    [
      'context mismatch',
      (p: ReturnType<typeof fixture>) => {
        p.legacyExecutors[0]!.scope = {
          ...p.legacyExecutors[0]!.scope,
          contextId: randomUUID(),
        };
      },
    ],
    [
      'duplicate context',
      (p: ReturnType<typeof fixture>) => {
        p.snapshots.push(structuredClone(p.snapshots[0]!));
        p.legacyExecutors.push(structuredClone(p.legacyExecutors[0]!));
      },
    ],
    [
      'relative namespace',
      (p: ReturnType<typeof fixture>) => {
        p.legacyExecutors[0]!.storageNamespace = 'relative/sessions';
      },
    ],
    [
      'dot namespace',
      (p: ReturnType<typeof fixture>) => {
        p.legacyExecutors[0]!.storageNamespace =
          '/old/../' + p.legacyExecutors[0]!.storageNamespace;
      },
    ],
    [
      'foreign namespace',
      (p: ReturnType<typeof fixture>) => {
        p.legacyExecutors[0]!.storageNamespace = '/other/sessions';
      },
    ],
    [
      'protected PPT',
      (p: ReturnType<typeof fixture>) => {
        p.snapshots[0]!.scope.contextId =
          '68e76b6b-2e75-45b7-b628-951945b12044';
      },
    ],
  ] as const)
    it('rejects ' + name, () => {
      const p = fixture();
      change(p);
      expect(() => nativeTerminalTestPhysicalScope(signed(p))).toThrow();
    });
  it('bounds this explicit reviewed batch to seven scopes', () => {
    const p = fixture();
    for (let i = 1; i < 8; i++) {
      const other = fixture();
      p.snapshots.push(other.snapshots[0]!);
      p.legacyExecutors.push(other.legacyExecutors[0]!);
    }
    expect(() => NativeChatTerminalCutoffPlanSchema.parse(signed(p))).toThrow();
  });
});
