import { createHash, randomUUID } from 'node:crypto';
import type {
  PersonalSkillDefinition,
  RequestContext,
} from '@allrice/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { packageVersionChecksum } from '../employees/personal-skill-model.ts';
import { createPostgresPersonalSkillPackageSource } from './personal-skill-package-source.ts';

const hash = (value: string) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const pending = <T>(promise: Promise<T>) =>
  Object.assign(promise, { cancel: vi.fn() });

function fixture(packaged = false) {
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: randomUUID() },
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    memberships: [],
    authenticatedAt: '2026-11-21T00:00:00.000Z',
  };
  const scope = { workspaceId: context.workspaceId!, instanceId: randomUUID() };
  const content = '# 周报\n保留原文与权限。\n';
  const definition: PersonalSkillDefinition = {
    name: 'weekly-summary',
    description: 'Prepare a weekly summary.',
    content,
    checksum: hash(content),
    invocation: { modelInvocable: true, userInvocable: false },
    whenToUse: 'When summarizing a week.',
    metadata: { version: '1.2.3' },
  };
  const payload = {
    schemaVersion: 1 as const,
    archiveObjectId: randomUUID(),
    sourcePath: 'weekly/SKILL.md',
    resources: [
      {
        path: 'references/rules.md',
        mediaType: 'text/markdown',
        byteLength: 4,
        checksum: hash('rule'),
      },
    ],
  };
  const manifest = packaged
    ? { ...payload, checksum: runtimePolicyDigest(payload) }
    : null;
  const version = {
    version: 2,
    definition,
    definition_checksum: runtimePolicyDigest(definition),
    resource_manifest: manifest,
    package_checksum: manifest
      ? packageVersionChecksum(runtimePolicyDigest(definition), manifest)
      : null,
  };
  const pin = {
    organizationId: context.organizationId,
    ownerId: context.actor.id,
    instanceId: scope.instanceId,
    installationId: randomUUID(),
    versionId: randomUUID(),
    bindingId: randomUUID(),
    bindingEpoch: 3,
    definitionChecksum: version.definition_checksum,
    ...(version.package_checksum
      ? { packageChecksum: version.package_checksum }
      : {}),
  };
  // Scripted SQL and current are contract substitutes, not a real identity/DB.
  const current = vi.fn(async (signal: AbortSignal) => {
    signal.throwIfAborted();
  });
  const requests: ReturnType<typeof pending<unknown[]>>[] = [];
  const tx = vi.fn(() => {
    const result = pending<unknown[]>(Promise.resolve([version]));
    requests.push(result);
    return result;
  });
  const begin = vi.fn(
    async (_mode: string, run: (sql: TransactionSql) => Promise<unknown>) =>
      run(tx as unknown as TransactionSql),
  );
  const db = Object.assign(vi.fn(), { begin }) as unknown as Sql;
  const host = { context, scope, requireCurrent: current };
  const abort = new AbortController();
  const read = () =>
    createPostgresPersonalSkillPackageSource(db, host).readPackage(
      pin,
      abort.signal,
    );
  return {
    context,
    scope,
    definition,
    version,
    pin,
    current,
    requests,
    tx,
    begin,
    db,
    host,
    abort,
    read,
  };
}

describe('exact personal package core; current/SQL are explicit contract substitutes', () => {
  it.each([false, true])(
    'returns actual UTF-8 body and original package semantics (package=%s)',
    async (packaged) => {
      const f = fixture(packaged),
        result = await f.read();
      expect(result.definition).toEqual(f.definition);
      expect(result.bodyBytes).toEqual(
        new TextEncoder().encode(f.definition.content),
      );
      expect(result.bodyChecksum).toBe(hash(f.definition.content));
      expect(result.bodyChecksum).not.toBe(f.pin.definitionChecksum);
      expect(result.pin).toEqual(f.pin);
      expect(result.installationVersion).toBe(2);
      expect(result.manifest).toEqual(f.version.resource_manifest);
      expect(result).not.toHaveProperty('resourceBytes');
      expect(f.current.mock.calls).toEqual([
        [f.abort.signal],
        [f.abort.signal],
      ]);
      expect(f.begin).toHaveBeenCalledTimes(2);
      expect(
        f.requests.every((request) => request.cancel.mock.calls.length === 0),
      ).toBe(true);
      if (!packaged) expect(result.pin).not.toHaveProperty('packageChecksum');
    },
  );

  it.each(['organizationId', 'ownerId', 'instanceId'] as const)(
    'rejects foreign %s before current or SQL',
    async (key) => {
      const f = fixture();
      f.pin[key] = randomUUID();
      await expect(f.read()).rejects.toMatchObject({ code: 'unavailable' });
      expect(f.current).not.toHaveBeenCalled();
      expect(f.begin).not.toHaveBeenCalled();
    },
  );

  it('rejects absent current, mismatched workspace and malformed pins without IO', async () => {
    const f = fixture();
    f.host.requireCurrent = undefined as unknown as typeof f.current;
    await expect(f.read()).rejects.toMatchObject({ code: 'unavailable' });
    f.host.requireCurrent = f.current;
    f.context.workspaceId = randomUUID();
    await expect(f.read()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    await expect(
      createPostgresPersonalSkillPackageSource(f.db, f.host).readPackage(
        { ...f.pin, extra: true },
        f.abort.signal,
      ),
    ).rejects.toBeDefined();
    expect(f.current).not.toHaveBeenCalled();
    expect(f.begin).not.toHaveBeenCalled();
  });

  it('accepts an owner-resolved workspace for a null RC workspace, but rejects a non-user actor', async () => {
    const f = fixture();
    f.context.workspaceId = null;
    expect((await f.read()).pin).toEqual(f.pin);
    f.context.actor = { type: 'system', id: 'allrice' };
    f.begin.mockClear();
    await expect(f.read()).rejects.toMatchObject({
      code: 'authentication_required',
    });
    expect(f.begin).not.toHaveBeenCalled();
  });

  it.each(['definition', 'body', 'manifest', 'package'] as const)(
    'rejects corrupt %s bytes/digests',
    async (kind) => {
      const f = fixture(true);
      if (kind === 'definition')
        f.version.definition = { ...f.definition, description: 'changed' };
      if (kind === 'body') {
        f.definition.checksum = hash('wrong body');
        f.version.definition_checksum = f.pin.definitionChecksum =
          runtimePolicyDigest(f.definition);
      }
      if (kind === 'manifest')
        f.version.resource_manifest!.resources[0]!.byteLength++;
      if (kind === 'package')
        f.version.package_checksum = f.pin.packageChecksum =
          hash('wrong package');
      await expect(f.read()).rejects.toMatchObject({ code: 'unavailable' });
    },
  );

  it('does no IO for pre-cancellation and joins a canceled deferred current call', async () => {
    const f = fixture();
    f.abort.abort();
    await expect(f.read()).rejects.toBe(f.abort.signal.reason);
    expect(f.current).not.toHaveBeenCalled();
    const g = fixture(),
      started = deferred<void>(),
      gate = deferred<void>();
    g.current.mockImplementation(async () => {
      started.resolve();
      await gate.promise;
    });
    const settled = vi.fn(),
      read = g.read(),
      handled = read.then(settled, settled);
    await started.promise;
    g.abort.abort();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    gate.resolve();
    await expect(read).rejects.toBe(g.abort.signal.reason);
    await handled;
    expect(g.begin).not.toHaveBeenCalled();
  });

  it('joins a second current call and never returns prepared bytes after its failure', async () => {
    const f = fixture(),
      started = deferred<void>(),
      gate = deferred<void>();
    f.current
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        started.resolve();
        await gate.promise;
      });
    const read = f.read(),
      settled = vi.fn(),
      handled = read.then(settled, settled);
    await started.promise;
    const denied = Error('current qualification revoked');
    f.abort.abort();
    gate.reject(denied);
    const error = (await read.catch(
      (reason: unknown) => reason,
    )) as AggregateError;
    await handled;
    expect(error.errors).toEqual([denied, f.abort.signal.reason]);
    expect(error.errors[1]).toBe(f.abort.signal.reason);
    expect(error.cause).toBe(denied);
    expect(f.begin).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'joins deferred rollback and preserves original callback errors (cancel=%s)',
    async (cancel) => {
      const f = fixture(),
        rollingBack = deferred<unknown>(),
        cleanup = deferred<void>();
      const rollbackError = Error('actual driver rollback rejection');
      f.tx.mockImplementation(() => pending(Promise.resolve([])));
      f.begin.mockImplementation(async (_mode, run) => {
        try {
          return await run(f.tx as unknown as TransactionSql);
        } catch (original) {
          rollingBack.resolve(original);
          await cleanup.promise;
          throw rollbackError;
        }
      });
      const read = f.read(),
        settled = vi.fn(),
        handled = read.then(settled, settled);
      const original = await rollingBack.promise;
      expect(original).toMatchObject({ code: 'unavailable' });
      if (cancel) f.abort.abort();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      cleanup.resolve();
      const error = (await read.catch(
        (reason: unknown) => reason,
      )) as AggregateError;
      await handled;
      expect(error.cause).toBe(original);
      expect(error.errors).toEqual(
        cancel
          ? [original, rollbackError, f.abort.signal.reason]
          : [original, rollbackError],
      );
      expect(error.errors[0]).toBe(original);
      expect(error.errors[1]).toBe(rollbackError);
      if (cancel) expect(error.errors[2]).toBe(f.abort.signal.reason);
    },
  );

  it('cancels actual pending SQL and joins both SQL and rollback before rejecting', async () => {
    const f = fixture(),
      started = deferred<void>(),
      sql = deferred<unknown[]>(),
      cleanup = deferred<void>();
    const request = pending(sql.promise),
      rollingBack = deferred<void>();
    const sqlError = Error('SQL rejected after cancel');
    f.tx.mockImplementation(() => {
      started.resolve();
      return request;
    });
    f.begin.mockImplementation(async (_mode, run) => {
      try {
        return await run(f.tx as unknown as TransactionSql);
      } catch (original) {
        rollingBack.resolve();
        await cleanup.promise;
        throw original;
      }
    });
    const read = f.read(),
      settled = vi.fn(),
      handled = read.then(settled, settled);
    await started.promise;
    f.abort.abort();
    expect(request.cancel).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    sql.reject(sqlError);
    await rollingBack.promise;
    expect(settled).not.toHaveBeenCalled();
    cleanup.resolve();
    const error = (await read.catch(
      (reason: unknown) => reason,
    )) as AggregateError;
    await handled;
    expect(error.errors).toEqual([sqlError, f.abort.signal.reason]);
    expect(error.errors[0]).toBe(sqlError);
    expect(error.errors[1]).toBe(f.abort.signal.reason);
    expect(error.cause).toBe(sqlError);
  });

  it('joins transaction completion before suppressing cancellation of an otherwise successful read', async () => {
    const f = fixture(),
      completing = deferred<void>(),
      completion = deferred<void>();
    f.begin.mockImplementationOnce(async (_mode, run) => {
      const result = await run(f.tx as unknown as TransactionSql);
      completing.resolve();
      await completion.promise;
      return result;
    });
    const read = f.read(),
      settled = vi.fn(),
      handled = read.then(settled, settled);
    await completing.promise;
    f.abort.abort();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    completion.resolve();
    await expect(read).rejects.toBe(f.abort.signal.reason);
    await handled;
    expect(f.current).toHaveBeenCalledOnce();
  });
});
