import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type {
  PersonalSkillDefinition,
  PersonalSkillPin,
} from '@allrice/contracts';
import {
  createBuiltinSkillSourcesPort,
  runtimePolicyDigest,
  skillBytesChecksum,
  type createPostgresPersonalSkillPackageSource,
} from '@allrice/database';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry, {
  isModelInvocable,
  isUserInvocable,
} from '@deepseek-ai/dsh-skill';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerNativeCapabilitySkillProvider,
  type NativeCapabilitySkillConfiguration,
} from './native-capability-skill-provider.js';

const contexts: Context[] = [];
const signal = () => new AbortController().signal;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function personalPackage() {
  const pin: PersonalSkillPin = {
    organizationId: randomUUID(),
    ownerId: randomUUID(),
    instanceId: randomUUID(),
    installationId: randomUUID(),
    versionId: randomUUID(),
    bindingId: randomUUID(),
    bindingEpoch: 1,
    definitionChecksum: `sha256:${'a'.repeat(64)}`,
  };
  const definition: PersonalSkillDefinition = {
    name: 'weekly-private',
    description: 'Read my weekly summary instructions.',
    content: '# 周报\n保留 UTF-8 正文。\n',
    checksum: `sha256:${'b'.repeat(64)}`,
    invocation: { modelInvocable: false, userInvocable: true },
    whenToUse: 'When the user requests a weekly report.',
    metadata: { displayName: '周报', version: '1.0.0' },
  };
  definition.checksum = skillBytesChecksum(definition.content);
  pin.definitionChecksum = runtimePolicyDigest(definition);
  return {
    pin,
    definition,
    installationVersion: 1,
    bodyBytes: new TextEncoder().encode(definition.content),
    bodyChecksum: definition.checksum,
    manifest: null,
  };
}
async function fixture() {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(SkillRegistry);
  const builtin = createBuiltinSkillSourcesPort();
  const catalog = await builtin.listSources(signal());
  const web = catalog.sources.find((item) => item.name === 'web-research')!;
  const stored = personalPackage();
  const personal = {
    listPackagePins: vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      return [stored.pin];
    }),
    readPackage: vi.fn(async (pin: unknown, signal: AbortSignal) => {
      void pin;
      signal.throwIfAborted();
      return stored;
    }),
  } satisfies ReturnType<typeof createPostgresPersonalSkillPackageSource>;
  const host = {
    builtin: {
      ...builtin,
      readPackage: vi.fn(builtin.readPackage),
      readResource: vi.fn(builtin.readResource),
    },
    personal,
    requireCurrent: vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
    }),
    readConfiguration: vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      return config;
    }),
  };
  let config: NativeCapabilitySkillConfiguration = {
    builtinSkills: [web.selector],
    personalSkills: true,
  };
  let mounted!: ReturnType<typeof registerNativeCapabilitySkillProvider>;
  const fiber = ctx.inject(['skills'], (target) => {
    mounted = registerNativeCapabilitySkillProvider(target, host);
  });
  await fiber;
  return {
    ctx,
    host,
    web,
    stored,
    mounted,
    fiber,
    configure(value: NativeCapabilitySkillConfiguration) {
      config = value;
    },
  };
}
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
});

describe('actual native registry consuming AllRice sources; authority substitutes', () => {
  it('lists only configured sources and loads original bodies/policy through native get', async () => {
    const f = await fixture();
    const list = await f.ctx.skills.list();
    expect(list.map((item) => item.name)).toEqual([
      'web-research',
      'weekly-private',
    ]);
    expect(list.find((item) => item.name === f.web.name)?.invocation).toEqual({
      modelInvocable: f.web.modelInvocable,
      userInvocable: f.web.userInvocable,
    });
    const privateSummary = list.find((item) => item.name === 'weekly-private')!;
    expect(isModelInvocable(privateSummary)).toBe(false);
    expect(isUserInvocable(privateSummary)).toBe(true);
    const native = await f.ctx.skills.get('weekly-private');
    expect(native).toMatchObject({
      name: f.stored.definition.name,
      content: f.stored.definition.content,
      invocation: f.stored.definition.invocation,
      whenToUse: f.stored.definition.whenToUse,
      metadata: f.stored.definition.metadata,
      resourceBase: { kind: 'opaque' },
    });
    expect(native).not.toHaveProperty('checksum');
    const web = await f.ctx.skills.get('web-research');
    expect(web?.content).toBe(
      (await f.host.builtin.readPackage(f.web.selector, signal())).content,
    );
    expect(web).not.toHaveProperty('path');
    expect(web?.resourceBase).toEqual({
      kind: 'opaque',
      description: expect.stringContaining('resource bytes are not exposed'),
    });
    expect(f.host.builtin.readResource).not.toHaveBeenCalled();
    expect(f.host.personal.readPackage).toHaveBeenLastCalledWith(
      f.stored.pin,
      expect.any(AbortSignal),
    );
  });

  it('has no default static or personal enablement, including an empty catalog', async () => {
    const f = await fixture();
    f.configure({ builtinSkills: [], personalSkills: false });
    expect(await f.ctx.skills.snapshot()).toEqual({
      skills: [],
      complete: true,
    });
    expect(f.host.personal.listPackagePins).not.toHaveBeenCalled();
    expect(f.host.personal.readPackage).not.toHaveBeenCalled();
    expect(f.host.builtin.readPackage).not.toHaveBeenCalled();
    expect(f.host.requireCurrent).toHaveBeenCalledTimes(2);
  });

  it('rejects missing configuration/current without treating native incomplete as success', async () => {
    const f = await fixture();
    f.host.readConfiguration.mockResolvedValue(undefined!);
    expect(await f.ctx.skills.snapshot()).toEqual({
      skills: [],
      complete: false,
    });
    expect(f.host.personal.listPackagePins).not.toHaveBeenCalled();
    const failure = Error('current denied');
    f.host.requireCurrent.mockRejectedValue(failure);
    expect(await f.ctx.skills.snapshot()).toEqual({
      skills: [],
      complete: false,
    });
    expect(f.host.builtin.readPackage).not.toHaveBeenCalled();
    expect(() =>
      registerNativeCapabilitySkillProvider(f.ctx, {
        ...f.host,
        requireCurrent: undefined!,
      }),
    ).toThrow('native_capability_skill_unavailable');
  });

  it('checks current on cached get and refreshes native discovery on invalidation', async () => {
    const f = await fixture();
    await f.ctx.skills.list();
    const reads = f.host.personal.readPackage.mock.calls.length;
    const denied = Error('employee revoked');
    f.host.requireCurrent.mockRejectedValue(denied);
    await expect(f.ctx.skills.get('weekly-private')).rejects.toBe(denied);
    expect(f.host.personal.readPackage).toHaveBeenCalledTimes(reads);
    f.mounted.invalidate();
    expect(await f.ctx.skills.snapshot()).toEqual({
      skills: [],
      complete: false,
    });
    f.host.requireCurrent.mockImplementation(async (signal) => {
      signal.throwIfAborted();
    });
    f.configure({ builtinSkills: [], personalSkills: false });
    f.mounted.invalidate();
    expect(await f.ctx.skills.list()).toEqual([]);
    expect(await f.ctx.skills.get('weekly-private')).toBeUndefined();
  });

  it('rechecks configuration after actual body IO before returning a cached candidate', async () => {
    const f = await fixture();
    await f.ctx.skills.list();
    const entered = deferred<void>();
    const body = deferred<typeof f.stored>();
    f.host.personal.readPackage.mockImplementationOnce(async () => {
      entered.resolve();
      return body.promise;
    });
    const read = f.ctx.skills.get('weekly-private').catch((error) => error);
    await entered.promise;
    f.configure({ builtinSkills: [f.web.selector], personalSkills: false });
    body.resolve(f.stored);
    expect(await read).toEqual(Error('native_capability_skill_unavailable'));
  });

  it('keeps the selected exact pin until native invalidation, rather than following a new pointer', async () => {
    const f = await fixture();
    await f.ctx.skills.list();
    const next = { ...f.stored.pin, versionId: randomUUID() };
    f.host.personal.listPackagePins.mockResolvedValue([next]);
    await f.ctx.skills.get('weekly-private');
    expect(f.host.personal.readPackage).toHaveBeenLastCalledWith(
      f.stored.pin,
      expect.any(AbortSignal),
    );
    f.mounted.invalidate();
    await f.ctx.skills.get('weekly-private');
    expect(f.host.personal.readPackage).toHaveBeenLastCalledWith(
      next,
      expect.any(AbortSignal),
    );
  });

  it('joins actual pending read/cleanup after native caller abort and keeps both error objects', async () => {
    const f = await fixture();
    await f.ctx.skills.list();
    const entered = deferred<AbortSignal>();
    const body = deferred<typeof f.stored>();
    let cleaned = false;
    f.host.personal.readPackage.mockImplementationOnce(async (_pin, signal) => {
      entered.resolve(signal);
      try {
        return await body.promise;
      } finally {
        cleaned = true;
      }
    });
    const caller = new AbortController();
    const read = f.ctx.skills
      .get('weekly-private', { signal: caller.signal })
      .catch((error) => error);
    const sourceSignal = await entered.promise;
    const cancelled = Error('caller cancelled');
    const failed = Error('actual source close failed');
    caller.abort(cancelled);
    expect(await read).toBe(cancelled); // Native race is deliberately preserved.
    expect(sourceSignal.reason).toBe(cancelled);
    let disposed = false;
    const closing = f.mounted.dispose().then(
      () => {
        disposed = true;
      },
      (error) => {
        disposed = true;
        return error;
      },
    );
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(cleaned).toBe(false);
    body.reject(failed);
    const error = await closing;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toBe(failed);
    expect(error.errors).toEqual([failed, cancelled]);
    expect(error.errors[0]).toBe(failed);
    expect(error.errors[1]).toBe(cancelled);
    expect(cleaned).toBe(true);
    expect(await f.ctx.skills.list()).toEqual([]);
  });

  it('reports a source failure settled after native caller abort but before owner disposal', async () => {
    const f = await fixture();
    await f.ctx.skills.list();
    const entered = deferred<AbortSignal>();
    const body = deferred<typeof f.stored>();
    const cleaned = deferred<void>();
    const unhandled = vi.fn();
    // Observe without suppressing Vitest's own unhandled-rejection reporting.
    process.on('unhandledRejection', unhandled);
    try {
      f.host.personal.readPackage.mockImplementationOnce(
        async (_pin, signal) => {
          entered.resolve(signal);
          try {
            return await body.promise;
          } finally {
            cleaned.resolve();
          }
        },
      );
      const caller = new AbortController();
      const read = f.ctx.skills
        .get('weekly-private', { signal: caller.signal })
        .catch((error) => error);
      const sourceSignal = await entered.promise;
      const cancelled = Error('caller cancelled before source settled');
      const failed = Error('late actual source close failed');
      caller.abort(cancelled);
      expect(await read).toBe(cancelled);
      expect(sourceSignal.reason).toBe(cancelled);
      body.reject(failed);
      await cleaned.promise;
      // Drain this local promise chain and Node's unhandled reporting before
      // disposal starts; no wait duration or test timeout is added.
      await setImmediate();
      expect(unhandled).not.toHaveBeenCalled();
      const error = await f.mounted.dispose().catch((error) => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.cause).toBe(failed);
      expect(error.errors).toEqual([failed, cancelled]);
      expect(error.errors[0]).toBe(failed);
      expect(error.errors[1]).toBe(cancelled);
      expect(await f.ctx.skills.list()).toEqual([]);
      await setImmediate();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      body.resolve(f.stored);
    }
  });

  it('uses actual fiber disposal to abort and join a pending current call', async () => {
    const f = await fixture();
    const entered = deferred<AbortSignal>();
    const gate = deferred<void>();
    f.host.requireCurrent.mockImplementationOnce(async (signal) => {
      entered.resolve(signal);
      await gate.promise;
      signal.throwIfAborted();
    });
    const listing = f.ctx.skills.snapshot();
    const actualSignal = await entered.promise;
    let closed = false;
    const aborted = deferred<void>();
    actualSignal.addEventListener('abort', () => aborted.resolve(), {
      once: true,
    });
    const disposal = f.fiber.dispose().finally(() => {
      closed = true;
    });
    await aborted.promise;
    expect(actualSignal.aborted).toBe(true);
    expect(closed).toBe(false);
    gate.resolve();
    await disposal;
    expect((await listing).skills).toEqual([]);
    expect(closed).toBe(true);
    expect(f.host.personal.listPackagePins).not.toHaveBeenCalled();
  });
});
