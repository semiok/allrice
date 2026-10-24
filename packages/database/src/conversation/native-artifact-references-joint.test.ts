/** Pure orchestration boundary only. Verified receipt readers are fake ports;
 * the scanner and close-coverage policy are production source. No SQL/SDK I/O. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as closeObservations from '../providers/dsh-runtime-close-observations.ts';
const ports = vi.hoisted(() => ({
  chat: [] as Record<string, unknown>[],
  terminal: [] as Record<string, unknown>[],
  transitions: [] as Record<string, unknown>[],
  close: [] as Record<string, unknown>[],
  nullChats: [] as Record<string, unknown>[],
  referenceRows: [] as Record<string, unknown>[],
  queries: [] as { text: string; values: unknown[] }[],
  snapshots: [] as string[],
  resolverCalls: 0,
  terminalError: null as Error | null,
}));
vi.mock('../core/client.ts', () => ({
  getDatabase: () => ({
    begin: async (mode: string, work: (tx: unknown) => Promise<unknown>) => {
      ports.snapshots.push(mode);
      const tx = Object.assign(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.join('?');
          ports.queries.push({ text, values });
          if (text.startsWith('with approved')) return [...ports.referenceRows];
          if (text.startsWith('select c.id,c.organization_id'))
            return ports.nullChats;
          if (text.includes('to_regclass')) return [{ available: false }];
          if (text.startsWith('set local')) return [];
          throw Error('Unexpected fake SQL port: ' + text);
        },
        { json: (value: unknown) => value },
      );
      return work(tx);
    },
  }),
}));
vi.mock('./native-context-retirement.ts', () => ({
  readVerifiedNativeChatRetirements: async () => ports.chat,
}));
vi.mock('./native-terminal-test-retirement.ts', () => ({
  readVerifiedNativeTerminalTestRetirements: async () => {
    if (ports.terminalError) throw ports.terminalError;
    return ports.terminal;
  },
}));
vi.mock('./native-executor-transition.ts', () => ({
  verifiedChatExecutorTransitions: async () => {
    ports.resolverCalls++;
    return ports.transitions;
  },
}));
vi.mock('./native-origin-reader.ts', () => ({
  configuredNativeOriginReaders: () => [],
}));
vi.mock('../providers/dsh-runtime-close-observations.ts', async (original) => ({
  ...(await original<typeof closeObservations>()),
  readDshRuntimeCloseCoverage: async () => ports.close,
}));
import { verifyNativeArtifactReferenceCoverage as verify } from './native-artifact-references.ts';

const current = 'sha256:' + 'a'.repeat(64);
const legacy = 'sha256:' + 'b'.repeat(64);
const generation = 'dsh-0.2.1-rc.2-687f282';
const scope = {
  contextKind: 'chat',
  contextId: '22222222-2222-4222-8222-222222222222',
  organizationId: '33333333-3333-4333-8333-333333333333',
  workspaceId: '44444444-4444-4444-8444-444444444444',
  ownerId: '55555555-5555-4555-8555-555555555555',
};
const approvals: Parameters<typeof verify>[0] = [
  {
    artifactId: current,
    generation,
    storageRoot: '/synthetic/current',
    previewStorageRoot: '/synthetic/preview',
  },
];
function nullChat() {
  return {
    id: scope.contextId,
    organization_id: scope.organizationId,
    workspace_id: scope.workspaceId,
    owner_id: scope.ownerId,
  };
}
function transition(schemaVersion: 1 | 2) {
  // A preverified reader result, not a forged approval/receipt API input.
  return {
    schemaVersion,
    scope: { ...scope },
    target: { artifactId: current, generation, profileId: 'restricted' },
    originDigest: current,
    storageNamespace: '/synthetic/current/sessions',
  };
}
function unconfirmed(physical: 'unknown' | 'exited', contextKind: string) {
  return {
    owner: {
      runtimeId: '66666666-6666-4666-8666-666666666666',
      workerBootId: '77777777-7777-4777-8777-777777777777',
      artifactId: legacy,
      context: { ...scope, kind: 'context', contextKind },
    },
    physical,
    publicClose: 'unconfirmed',
  };
}
beforeEach(() => {
  for (const list of [
    ports.chat,
    ports.terminal,
    ports.transitions,
    ports.close,
    ports.nullChats,
    ports.referenceRows,
    ports.queries,
    ports.snapshots,
  ])
    list.length = 0;
  ports.resolverCalls = 0;
  ports.terminalError = null;
  vi.stubEnv('ALLRICE_DSH_RETAINED_1_ARTIFACT_ID', legacy);
});
afterEach(() => vi.unstubAllEnvs());
describe('joint chat transition/adoption and terminal cutoff reference boundary', () => {
  it.each([1, 2] as const)(
    'keeps verified schema%s on the same resolver and snapshot while carrying terminal scopes separately',
    async (version) => {
      ports.transitions.push(transition(version));
      ports.terminal.push({ ...scope, contextKind: 'platform_employee_test' });
      if (version === 2) ports.nullChats.push(nullChat());
      const result = await verify(approvals);
      expect(result.verified).toBe(true);
      expect(ports.resolverCalls).toBe(1);
      expect(ports.snapshots).toEqual([
        'isolation level repeatable read read only',
      ]);
      const query = ports.queries.find((q) =>
        q.text.startsWith('with approved'),
      )!;
      expect(query.values[2]).toEqual([
        {
          contextId: scope.contextId,
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          ownerId: scope.ownerId,
          targetArtifactId: current,
          generation,
          originDigest: current,
          storageNamespace: '/synthetic/current/sessions',
        },
      ]);
      expect(query.values[3]).toEqual(ports.terminal);
      expect(result.retiredContexts).toEqual(ports.terminal);
    },
  );
  it('retains an untouched NULL chat as an implicit legacy dependency', async () => {
    ports.nullChats.push(nullChat());
    await expect(verify(approvals)).rejects.toThrow('REFERENCES_UNCOVERED');
  });
  it('a nonchat cutoff with the same UUID and tenant cannot hide a business NULL chat', async () => {
    ports.nullChats.push(nullChat());
    ports.terminal.push({ ...scope, contextKind: 'platform_employee_test' });
    await expect(verify(approvals)).rejects.toThrow('REFERENCES_UNCOVERED');
  });
  it('accepts only an exact chat retirement for the NULL chat fallback', async () => {
    ports.nullChats.push(nullChat());
    ports.chat.push({ ...scope });
    await expect(verify(approvals)).resolves.toMatchObject({ verified: true });
  });
  it('an adoption for another owner cannot cover a NULL chat', async () => {
    ports.nullChats.push(nullChat());
    ports.transitions.push({
      ...transition(2),
      scope: { ...scope, ownerId: '88888888-8888-4888-8888-888888888888' },
    });
    await expect(verify(approvals)).rejects.toThrow('REFERENCES_UNCOVERED');
  });
  it('a verified adoption still requires its exact target in current approval', async () => {
    const receipt = transition(2);
    receipt.target.artifactId = legacy;
    ports.transitions.push(receipt);
    await expect(verify(approvals)).rejects.toThrow(
      'TRANSITION_TARGET_UNVERIFIED',
    );
  });
  it('preservation mismatch cannot be swallowed by transition resolution', async () => {
    ports.terminalError = Error('NATIVE_TERMINAL_PRESERVED_FACTS_CHANGED');
    await expect(verify(approvals)).rejects.toThrow('PRESERVED_FACTS_CHANGED');
    expect(ports.resolverCalls).toBe(0);
  });
  it.each(['unknown', 'exited'] as const)(
    'keeps a registered nonchat owner %s/unconfirmed blocking even with a cutoff',
    async (physical) => {
      ports.terminal.push({ ...scope, contextKind: 'platform_employee_test' });
      ports.close.push(unconfirmed(physical, 'platform_employee_test'));
      await expect(verify(approvals)).rejects.toThrow('CLOSE_UNCONFIRMED');
    },
  );
  it('retains the original exact exited chat discard rule without granting it to nonchat', async () => {
    ports.chat.push({ ...scope });
    ports.close.push(unconfirmed('exited', 'chat'));
    await expect(verify(approvals)).resolves.toMatchObject({ verified: true });
  });
});
