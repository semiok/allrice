// AllRice control-only adapter, loaded solely from the exact approved artifact.
// No credentials-local, provider, webserver, database or arbitrary module import.
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
const TITLE = 'AllRice once control';
const PROMPT = 'Synthetic schedule control only. Never execute business work.';
const INIT = 'Initialize isolated once control. No business execution.';
const PROVIDER = 'allrice-schedule-control-denied';
const MODEL = 'denied';
const BACKEND = 'allrice-native-once';
export async function openNativeScheduleControlHost(
  { source, backend, auxiliaryBackend, stats },
  NativeScheduleOnceError,
) {
  const m = await source.loadModules();
  const ctx = new m.cordis.Context();
  let server;
  let scheduleFiber;
  let bootTask, mountTask, closing;
  let stopping = false;
  const live = () => {
    if (stopping) throw new NativeScheduleOnceError('closed');
  };
  // These gates live for the entire context, including initialization and replay.
  ctx.on('agent/pre-step', async () => {
    stats.preStepDenials++;
    return { kind: 'reject' };
  });
  // eslint-disable-next-line require-yield -- Control streams always reject before producing a chunk.
  ctx.on('llm/stream', async function* () {
    stats.modelGateDenials++;
    throw new NativeScheduleOnceError('closed');
  });
  class DeniedAdapter extends m.llm.LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model };
    }
    // eslint-disable-next-line require-yield -- The denied adapter never produces a model chunk.
    async *stream() {
      stats.adapterCalls++;
      throw new NativeScheduleOnceError('closed');
    }
  }
  // The local credentials plugin falls back to process.env/.env. Control does
  // not mount it. Only the carrier's ephemeral browser-session signing record
  // is allowed in memory; no web server, provider credentials or ambient lookup.
  const browserKey = m.credentials.credentialKey(
    'client-connection',
    'browser-session',
  );
  class ControlCredentials extends m.credentials.CredentialProvider {
    browserRecord;
    changes = Promise.resolve();
    async resolve() {
      return undefined;
    }
    async describe() {
      return { configured: false, writable: false };
    }
    async set() {
      throw new NativeScheduleOnceError('closed');
    }
    async unset() {
      throw new NativeScheduleOnceError('closed');
    }
    async readRecord(key) {
      return key === browserKey
        ? globalThis.structuredClone(this.browserRecord)
        : undefined;
    }
    async describeRecord(key) {
      return {
        configured: key === browserKey && !!this.browserRecord,
        writable: key === browserKey,
      };
    }
    async listRecords() {
      return this.browserRecord
        ? [{ key: browserKey, kind: this.browserRecord.kind }]
        : [];
    }
    modifyRecord(key, mutate) {
      const operation = this.changes.then(async () => {
        live();
        if (key !== browserKey) throw new NativeScheduleOnceError('closed');
        const replacement = await mutate(
          globalThis.structuredClone(this.browserRecord),
        );
        if (replacement !== undefined) {
          if (replacement.kind !== 'grant')
            throw new NativeScheduleOnceError('closed');
          this.browserRecord = globalThis.structuredClone(replacement);
        }
        return globalThis.structuredClone(this.browserRecord);
      });
      this.changes = operation.catch(() => undefined);
      return operation;
    }
    async deleteRecord() {
      throw new NativeScheduleOnceError('closed');
    }
  }
  const sdk = () => {
    live();
    if (!server) throw new NativeScheduleOnceError('host_failed');
    return server;
  };
  return {
    boot() {
      bootTask ??= (async () => {
        live();
        const root = source.reference.stateRoot;
        if (!isAbsolute(root))
          throw new NativeScheduleOnceError('binding_invalid');
        await mkdir(root, { recursive: true, mode: 0o700 });
        live();
        await ctx.plugin(m.llm.default);
        await ctx.plugin(m.sessions.default);
        await ctx.plugin(m.projections.default);
        await ctx.plugin(m.systemPrompt.default, {});
        await ctx.plugin(m.files.default);
        await ctx.plugin(m.directory.default);
        await ctx.plugin(m.tools.default, {});
        ctx.tools.guard(() => {
          stats.toolDenials++;
          return 'NATIVE_SCHEDULE_CONTROL_TOOLS_DENIED';
        });
        await ctx.plugin(m.agents.default);
        await ctx.plugin(m.loop.default, { agents: [] });
        await ctx.plugin(m.jsonl, {
          root: join(root, 'sessions'),
          compression: 'none',
        });
        live();
        await ctx.plugin(m.storage.default);
        ctx.storage.backend.register(BACKEND, backend);
        ctx.provide(m.storage.storageBackendServiceKey(BACKEND), backend);
        ctx.storage.backend.register(
          'allrice-native-once-auxiliary',
          auxiliaryBackend,
        );
        ctx.provide(
          m.storage.storageBackendServiceKey('allrice-native-once-auxiliary'),
          auxiliaryBackend,
        );
        await ctx.plugin(m.domain, {
          backend: 'allrice-native-once-auxiliary',
          routes: { schedule: BACKEND },
        });
        await ctx.plugin(m.workspace.default);
        await ctx.plugin(m.typert.default);
        class DenyRemoteAccess extends m.cordis.Service {
          constructor(ctx) {
            super(ctx, 'remoteAccess');
          }
          allows() {
            return false;
          }
          require() {
            throw new NativeScheduleOnceError('closed');
          }
        }
        await ctx.plugin(DenyRemoteAccess);
        await ctx.plugin(m.defaultModel.default, {
          provider: PROVIDER,
          model: MODEL,
        });
        await ctx.plugin(ControlCredentials);
        await ctx.plugin(m.commands.default);
        await ctx.plugin(m.connection);
        await ctx.plugin(m.attachment.default, { dshHome: root });
        await ctx.plugin(m.upload.default);
        await ctx.plugin(m.query.default, {
          path: ':memory:',
          openAt: 'never',
        });
        await ctx.plugin(m.controller.default, { nativeOpen: false });
        live();
        ctx.llm.registerAdapter([PROVIDER], new DeniedAdapter());
        server = new m.sdk.HarnessSdkJsonRpcServer(ctx, {
          notify() {},
          request() {
            throw new NativeScheduleOnceError('closed');
          },
        });
        await server.initialize({
          cwd: root,
          provider: PROVIDER,
          model: MODEL,
        });
        live();
      })();
      return bootTask;
    },
    decodeTask(value) {
      return m.schedule.scheduleDomain.tables.tasks.valueSchema.parse(value);
    },
    async initializeSession(sessionId) {
      const owned = sdk();
      await owned.getWorkingDirectory({ sessionId });
      live();
      await owned.prompt({
        sessionId,
        contentBlocks: [{ type: 'text', text: INIT }],
      });
      await owned.wait({ sessionId });
      live();
      const session = ctx.sessions.get(m.sessions.SessionId(sessionId));
      if (!session || !(await ctx.sessions.flush(session)))
        throw new NativeScheduleOnceError('history_missing');
      live();
    },
    async resumeSession(sessionId) {
      await sdk().resume({ sessionId });
      live();
    },
    mountSchedule() {
      mountTask ??= (async () => {
        live();
        scheduleFiber = await ctx.plugin(m.schedule.default, {});
        await ctx.schedule.catalog();
        live();
      })();
      return mountTask;
    },
    async catalog() {
      live();
      return ctx.schedule.catalog();
    },
    async createOnce(sessionId, at) {
      live();
      try {
        return await ctx.schedule.create(m.sessions.SessionId(sessionId), {
          title: TITLE,
          prompt: PROMPT,
          at,
        });
      } catch (error) {
        if (
          error instanceof m.schedule.ScheduleInputError &&
          error.code === 'not_future'
        )
          throw new NativeScheduleOnceError('target_not_future');
        throw error;
      }
    },
    async createRecurring(sessionId, rule) {
      live();
      const timing = recurringTiming(rule);
      return ctx.schedule.create(m.sessions.SessionId(sessionId), {
        title: TITLE,
        prompt: PROMPT,
        ...(timing.kind === 'every'
          ? { every_seconds: timing.every_seconds }
          : { daily: timing.daily }),
      });
    },
    async updateRecurring(sessionId, id, expected, rule) {
      live();
      const result = await ctx.schedule.update({
        sessionId: m.sessions.SessionId(sessionId),
        id: m.schedule.ScheduleId(id),
        expected: globalThis.structuredClone(expected),
        change: recurringTiming(rule),
        title: TITLE,
        prompt: PROMPT,
      });
      if ('record' in result) return result.record;
      if ('code' in result && result.code === 'schedule_conflict') return null;
      throw new NativeScheduleOnceError('task_invalid');
    },
    async deleteOnce(sessionId, id) {
      live();
      await ctx.schedule.delete({
        sessionId: m.sessions.SessionId(sessionId),
        id: m.schedule.ScheduleId(id),
      });
    },
    close() {
      stopping = true;
      closing ??= (async () => {
        await bootTask?.catch(() => undefined);
        await mountTask?.catch(() => undefined);
        const failures = [];
        // Root disposal is concurrent; public consumers must drain before it.
        for (const end of [
          () => scheduleFiber?.dispose(),
          () => server?.shutdown(),
          () => ctx.fiber.dispose(),
        ])
          try {
            await end();
          } catch (error) {
            failures.push(error);
          }
        if (failures.length)
          throw new NativeScheduleOnceError('shutdown_failed');
      })();
      return closing;
    },
  };
  function recurringTiming(rule) {
    if (
      rule?.kind === 'every' &&
      Object.keys(rule).sort().join(',') === 'kind,seconds' &&
      Number.isSafeInteger(rule.seconds) &&
      rule.seconds >= 60 &&
      rule.seconds <= 31_536_000
    )
      return { kind: 'every', every_seconds: rule.seconds };
    if (
      rule?.kind === 'daily' &&
      Object.keys(rule).sort().join(',') === 'kind,time,timezone' &&
      /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(rule.time) &&
      typeof rule.timezone === 'string' &&
      rule.timezone.length <= 64
    ) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: rule.timezone });
      } catch {
        throw new NativeScheduleOnceError('binding_invalid');
      }
      return {
        kind: 'daily',
        daily: { time: rule.time, time_zone: rule.timezone },
      };
    }
    throw new NativeScheduleOnceError('binding_invalid');
  }
}
