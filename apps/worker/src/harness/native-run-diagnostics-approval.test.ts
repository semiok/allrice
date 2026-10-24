// Prepared regression file; apply only after actual U1/U2 APIs and C follow-up.
// The registry boundary is mocked here; its measurement/approval contract has
// independent tests. The positive case uses the real public JSONL read API.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, stat, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import {
  Session,
  SessionId,
  SESSION_FORMAT_VERSION,
} from '@deepseek-ai/dsh-session';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type {
  NativeDiagnosticTargetSlice,
  NativeSessionPin,
} from '@allrice/database';

const readers = vi.hoisted(() => ({ exact: vi.fn(), original: vi.fn() }));
vi.mock('./dsh-native-artifact.js', () => ({
  nativeArtifactLaunchForPin: readers.exact,
}));
vi.mock('./dsh-native-retention.js', () => ({
  pinnedDshNativeLaunch: readers.original,
}));
import {
  readApprovedNativeDiagnosticJournal,
  readNativeRunDiagnostics,
} from './native-run-diagnostics.js';

const originalArtifact = 'sha256:' + 'a'.repeat(64);
const actualArtifact = 'sha256:' + 'b'.repeat(64);
const pin: NativeSessionPin = {
  nativeSessionId: 'dsh-11111111-1111-4111-8111-111111111111',
  artifactId: originalArtifact,
  artifactManifestDigest: originalArtifact,
  distributionGeneration: 'dsh-0.2.1-rc.2-687f282',
  profileId: 'restricted',
  storageNamespace: '/private/never-read-for-unapproved-artifacts',
  storageContextKey: '44444444-4444-4444-8444-444444444444',
  organizationId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  ownerId: '33333333-3333-4333-8333-333333333333',
  contextKind: 'chat',
  contextId: '44444444-4444-4444-8444-444444444444',
  firstRunId: '55555555-5555-4555-8555-555555555555',
  firstJobId: '66666666-6666-4666-8666-666666666666',
  firstAttempt: 1,
  boundAt: '2026-10-24T00:00:00Z',
  bindingBasis: 'business_root_origin',
  rootOriginDigest: 'sha256:' + 'c'.repeat(64),
  originReaderApprovalDigest: 'sha256:' + 'd'.repeat(64),
};
const target: NativeDiagnosticTargetSlice = {
  attempt: 1,
  generation: 2,
  nativeSessionId: pin.nativeSessionId,
  receipts: [{ seq: 0, type: 'turn/start', turn: 1 }],
  verifiedTurns: [1],
  reasons: [],
  binding: pin,
  execution: {
    nativeSessionId: pin.nativeSessionId,
    artifactId: actualArtifact,
    artifactManifestDigest: actualArtifact,
    distributionGeneration: pin.distributionGeneration,
    profileId: pin.profileId,
    storageContextKey: pin.storageContextKey,
    storageNamespace: pin.storageNamespace,
    executorTransitionDigest: 'sha256:' + 'e'.repeat(64),
  },
};
const entrypoint = fileURLToPath(
  new URL('../../dsh/allrice-jsonrpc-runtime.mjs', import.meta.url),
);
const roots: string[] = [];
beforeEach(() => {
  readers.exact.mockReset().mockImplementation(() => {
    throw Error('PIN_NOT_APPROVED');
  });
  readers.original.mockReset().mockImplementation(() => {
    throw Error('ORIGINAL_READER_RETIRED');
  });
});
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function files(
  path: string,
): Promise<{ path: string; bytes: string; mtimeMs: number }[]> {
  const out = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const p = join(path, entry.name);
    if (entry.isDirectory()) out.push(...(await files(p)));
    else
      out.push({
        path: p,
        bytes: (await readFile(p)).toString('base64'),
        mtimeMs: (await stat(p)).mtimeMs,
      });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
function report(slice: NativeDiagnosticTargetSlice) {
  return readNativeRunDiagnostics(
    { runId: pin.firstRunId, running: false, reasons: [], slices: [slice] },
    new AbortController().signal,
  );
}

it('reads the exact transitioned artifact through public persistence when the original pin reader has retired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allrice-transition-diagnostic-'));
  roots.push(root);
  const namespace = join(
    root,
    pin.organizationId,
    pin.workspaceId,
    pin.ownerId,
    pin.contextId,
    'sessions',
  );
  await mkdir(namespace, { recursive: true });
  const ctx = new Context();
  const plugin = ctx.plugin(JsonlPersistence, {
    root: namespace,
    compression: 'none',
  });
  try {
    await plugin.await();
    const persistence = ctx.get('sessionPersistence') as SessionPersistence;
    const id = SessionId(pin.nativeSessionId);
    const header = {
      id,
      version: SESSION_FORMAT_VERSION,
      createdAt: 100,
      isSeeded: false,
    } as const;
    const session = Session.create(id, [], header);
    session.append('turn/start', { turn: 1 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const writer = await persistence.create(header);
    await writer.append(session.snapshotEvents());
    await writer.flush();
    await writer.close();
    const before = await files(namespace);
    const start = session
      .snapshotEvents()
      .find((event) => event.type === 'turn/start')!;
    const slice = {
      ...target,
      receipts: [{ seq: start.seq, type: start.type, turn: 1 }],
      binding: { ...pin, storageNamespace: namespace },
      execution: { ...target.execution!, storageNamespace: namespace },
    };
    readers.exact.mockReturnValue({
      artifactId: actualArtifact,
      generation: pin.distributionGeneration,
      args: [entrypoint],
    });
    const result = await report(slice);
    expect(result.status, JSON.stringify(result)).toBe('available');
    expect(result.slices[0]!.artifactId).toBe(actualArtifact);
    expect(result.slices[0]!.events.map((e) => e.type)).toEqual([
      'turn/start',
      'turn/end',
    ]);
    expect(readers.exact).toHaveBeenCalledExactlyOnceWith(slice.execution);
    expect(readers.original).not.toHaveBeenCalled();
    expect(await files(namespace)).toEqual(before);
    expect(JSON.stringify(result)).not.toContain(namespace);
    expect(pin.artifactId).toBe(originalArtifact);
  } finally {
    await plugin.dispose();
  }
});

it('keeps the actual artifact visible when its reader is retired without falling back to a current or original reader', async () => {
  const result = await report(target);
  expect(result.status).toBe('unavailable');
  expect(result.reasons).toContain('reader_unavailable');
  expect(result.slices[0]!.artifactId).toBe(actualArtifact);
  expect(readers.exact).toHaveBeenCalledExactlyOnceWith(target.execution);
  expect(readers.original).not.toHaveBeenCalled();
});

it('preserves an older untransitioned Run and its original approval requirement after a newer artifact is approved', async () => {
  readers.exact.mockReturnValue({
    artifactId: actualArtifact,
    generation: pin.distributionGeneration,
    args: [entrypoint],
  });
  const old = {
    ...target,
    execution: {
      ...target.execution!,
      artifactId: originalArtifact,
      artifactManifestDigest: originalArtifact,
      originReaderApprovalDigest: pin.originReaderApprovalDigest,
      executorTransitionDigest: undefined,
    },
  };
  const result = await report(old);
  expect(result.status).toBe('unavailable');
  expect(result.reasons).toContain('reader_unavailable');
  expect(result.slices[0]!.artifactId).toBe(originalArtifact);
  expect(readers.original).toHaveBeenCalledExactlyOnceWith(pin);
  expect(readers.exact).not.toHaveBeenCalled();
});

it.each([
  { storageNamespace: '/private/another-namespace' },
  { storageContextKey: 'another-context' },
  { profileId: 'technical' as const },
  { nativeSessionId: 'dsh-99999999-9999-4999-8999-999999999999' },
  { originReaderApprovalDigest: pin.originReaderApprovalDigest },
])(
  'rejects changed execution scope or inherited reader authority before reader selection: %j',
  async (change) => {
    await expect(
      readApprovedNativeDiagnosticJournal(
        { ...target, execution: { ...target.execution!, ...change } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: 'reader_unavailable' });
    expect(readers.exact).not.toHaveBeenCalled();
    expect(readers.original).not.toHaveBeenCalled();
  },
);
