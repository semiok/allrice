import { createHash, randomUUID } from 'node:crypto';
import type {
  PersonalSkillDefinition,
  RequestContext,
} from '@allrice/contracts';
import type { Sql } from 'postgres';
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
  const select = vi.fn(() => {
    const result = pending<unknown[]>(Promise.resolve([version]));
    requests.push(result);
    return result;
  });
  const begin = vi.fn();
  const db = Object.assign(select, { begin }) as unknown as Sql;
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
    select,
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
      expect(f.select).toHaveBeenCalledTimes(2);
      expect(f.begin).not.toHaveBeenCalled();
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
      expect(f.select).not.toHaveBeenCalled();
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
    expect(f.select).not.toHaveBeenCalled();
    expect(f.begin).not.toHaveBeenCalled();
  });

  it('accepts an owner-resolved workspace for a null RC workspace, but rejects a non-user actor', async () => {
    const f = fixture();
    f.context.workspaceId = null;
    expect((await f.read()).pin).toEqual(f.pin);
    f.context.actor = { type: 'system', id: 'allrice' };
    f.select.mockClear();
    await expect(f.read()).rejects.toMatchObject({
      code: 'authentication_required',
    });
    expect(f.select).not.toHaveBeenCalled();
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
    expect(g.select).not.toHaveBeenCalled();
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
    expect(f.select).toHaveBeenCalledOnce();
    expect(f.begin).not.toHaveBeenCalled();
  });

  it('rejects a missing joined row without starting transaction cleanup', async () => {
    const f = fixture();
    f.select.mockImplementation(() => pending(Promise.resolve([])));
    await expect(f.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.select).toHaveBeenCalledOnce();
    expect(f.current).toHaveBeenCalledOnce();
    expect(f.begin).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'joins pending SQL and preserves its error object (cancel=%s)',
    async (cancel) => {
      const f = fixture(),
        started = deferred<void>(),
        sql = deferred<unknown[]>();
      const request = pending(sql.promise),
        sqlError = Error('native SELECT connection failure');
      f.select.mockImplementation(() => {
        started.resolve();
        return request;
      });
      const read = f.read(),
        settled = vi.fn(),
        handled = read.then(settled, settled);
      await started.promise;
      if (cancel) f.abort.abort();
      expect(request.cancel).toHaveBeenCalledTimes(cancel ? 1 : 0);
      expect(settled).not.toHaveBeenCalled();
      sql.reject(sqlError);
      const error = await read.catch((reason: unknown) => reason);
      await handled;
      if (cancel) {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([
          sqlError,
          f.abort.signal.reason,
        ]);
        expect((error as AggregateError).errors[0]).toBe(sqlError);
        expect((error as AggregateError).errors[1]).toBe(f.abort.signal.reason);
        expect((error as Error).cause).toBe(sqlError);
      } else expect(error).toBe(sqlError);
      expect(f.select).toHaveBeenCalledOnce();
      expect(f.begin).not.toHaveBeenCalled();
    },
  );

  it('joins the final SELECT before suppressing a canceled successful read', async () => {
    const f = fixture(),
      started = deferred<void>(),
      sql = deferred<unknown[]>();
    const request = pending(sql.promise);
    f.select
      .mockImplementationOnce(() => pending(Promise.resolve([f.version])))
      .mockImplementationOnce(() => {
        started.resolve();
        return request;
      });
    const read = f.read(),
      settled = vi.fn(),
      handled = read.then(settled, settled);
    await started.promise;
    f.abort.abort();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(request.cancel).toHaveBeenCalledOnce();
    sql.resolve([f.version]);
    await expect(read).rejects.toBe(f.abort.signal.reason);
    await handled;
    expect(f.current).toHaveBeenCalledTimes(2);
    expect(f.select).toHaveBeenCalledTimes(2);
    expect(f.begin).not.toHaveBeenCalled();
  });
});
