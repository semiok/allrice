import { randomUUID } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEntryIdentitySchema, RequestContextSchema } from '@allrice/contracts';
import * as buildIdentity from './service-build-identity.ts';
import {
  builtinModules,
  createApplicationBuiltinModuleAuthority,
  readApplicationBuiltinModules,
} from './builtin-modules.ts';

const organizationId = randomUUID(),
  workspaceId = randomUUID(),
  personId = randomUUID();
// An availability input, not authenticated user authority. Real Cookie/current
// employee/resource checks are exercised by the HTTP+PostgreSQL direct suite.
const context = RequestContextSchema.parse({
  requestId: randomUUID(),
  sessionId: randomUUID(),
  actor: { type: 'user', id: personId },
  organizationId,
  workspaceId,
  memberships: [],
  authenticatedAt: new Date().toISOString(),
});
const identity = DEntryIdentitySchema.parse({
  organizationId,
  workspaceId,
  personId,
  employeeInstanceId: randomUUID(),
  employeeRevision: 1,
  employeeVersionId: randomUUID(),
  threadId: null,
});
const input = { moduleId: 'deliverables' as const, context, identity };
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.spyOn(buildIdentity, 'readServiceBuildIdentity').mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('ships one immutable all-enabled application policy for exactly the four approved builtins', async () => {
  const policy = await readApplicationBuiltinModules('web');
  expect(policy).toEqual({
    schemaVersion: 1,
    policy: 'all-enabled',
    applicationBuild: null,
    builtinModules: {
      deliverables: true,
      'enterprise-materials': true,
      'employee-memory': true,
      capabilities: true,
    },
  });
  expect(Object.isFrozen(policy)).toBe(true);
  expect(Reflect.set(builtinModules, 'deliverables', false)).toBe(false);
  expect(Reflect.set(builtinModules, 'foreign-module', true)).toBe(false);
  const authority = createApplicationBuiltinModuleAuthority('web');
  for (const moduleId of [
    'deliverables',
    'enterprise-materials',
    'employee-memory',
    'capabilities',
  ] as const)
    await expect(
      authority.require({ ...input, moduleId }, signal()),
    ).resolves.toBeUndefined();
});
it('projects only the existing verified application build identity, with no per-module version or digest', async () => {
  const verified: buildIdentity.ServiceBuildIdentity = {
    version: 1,
    environment: 'dev',
    service: 'worker',
    mode: 'production',
    sourceSha: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    manifestDigest: 'sha256:' + 'c'.repeat(64),
    artifactDigest: 'sha256:' + 'd'.repeat(64),
    runtimeGraphDigest: 'sha256:' + 'e'.repeat(64),
    webBuildId: 'sealed-application-build',
    bootId: randomUUID(),
    pid: 1,
    startedAt: new Date().toISOString(),
    nodeVersion: 'v22.23.2',
    protocols: {
      identity: 1,
      ordinaryConsumer: 1,
      releaseAdmission: 'disabled',
    },
  };
  const read = vi
    .mocked(buildIdentity.readServiceBuildIdentity)
    .mockResolvedValue(verified);
  const policy = await readApplicationBuiltinModules('worker');
  expect(read).toHaveBeenCalledWith('worker');
  expect(policy.applicationBuild).toEqual({
    sourceSha: verified.sourceSha,
    sourceTree: verified.sourceTree,
    manifestDigest: verified.manifestDigest,
    webBuildId: verified.webBuildId,
  });
  expect(Object.isFrozen(policy.applicationBuild)).toBe(true);
  expect(policy.builtinModules).toBe(builtinModules);
});
it('keeps legacy or development provenance unknown without inventing a release from env or caller scope', async () => {
  vi.stubEnv('ALLRICE_RELEASE_SHA', 'f'.repeat(40));
  const policy = await readApplicationBuiltinModules('web');
  expect(policy.applicationBuild).toBeNull();
  const authority = createApplicationBuiltinModuleAuthority('web');
  await authority.require(
    {
      ...input,
      ...{
        sourceSha: 'd'.repeat(40),
        enabled: false,
        release: 'browser-claim',
      },
    },
    signal(),
  );
  expect(
    (await readApplicationBuiltinModules('web')).applicationBuild,
  ).toBeNull();
  // Availability policy is application code, not the unverified version label.
  expect(policy.builtinModules.deliverables).toBe(true);
});
it('propagates a present invalid build verification instead of substituting env or an unverified success', async () => {
  const error = Error('DEV_BUILD_IDENTITY_INVALID');
  vi.mocked(buildIdentity.readServiceBuildIdentity).mockRejectedValue(error);
  await expect(readApplicationBuiltinModules('web')).rejects.toBe(error);
  await expect(
    createApplicationBuiltinModuleAuthority('web').require(input, signal()),
  ).rejects.toBe(error);
});
it('does no build read for an already cancelled module check', async () => {
  const stop = new AbortController(),
    reason = Error('cancelled before authority read');
  stop.abort(reason);
  await expect(
    createApplicationBuiltinModuleAuthority('web').require(input, stop.signal),
  ).rejects.toBe(reason);
  expect(buildIdentity.readServiceBuildIdentity).not.toHaveBeenCalled();
});
it('joins the actual pending build read before rejecting cancellation and discards its result', async () => {
  let entered!: () => void, finish!: (value: null) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<null>((resolve) => {
    finish = resolve;
  });
  vi.mocked(buildIdentity.readServiceBuildIdentity).mockImplementation(() => {
    entered();
    return pending;
  });
  const stop = new AbortController(),
    reason = Error('cancelled during authority read');
  let settled = false;
  const outcome = createApplicationBuiltinModuleAuthority('web')
    .require(input, stop.signal)
    .then(
      () => ({ error: null }),
      (error) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    await started;
    stop.abort(reason);
    await turn();
    expect(settled).toBe(false);
    finish(null);
    expect(await outcome).toEqual({ error: reason });
  } finally {
    finish(null);
    await outcome;
  }
});
