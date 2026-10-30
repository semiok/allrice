/* global AbortController */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

/** Worker-held Run capability over DSH's live registry. No child lifecycle,
 * capacity, queue or execution state is copied into an AllRice controller. */
export function installRunAdmission(host) {
  const { ctx } = host;
  let binding;
  const identities = new Map(); // Attribution retained until this Run releases.
  function closeInput(state) {
    state.inputClosed = true;
    state.inputAbort.abort(Error('RUN_COMPLETING'));
  }
  function current(runId = binding?.runId) {
    if (!binding || binding.closing || runId !== binding.runId)
      throw Error('RUN_NOT_ACTIVE');
    host.assertRoot(binding.record, binding.record.agent.id);
    return binding;
  }
  function identity(agent) {
    const state = current();
    const root = state.record.agent;
    const seen = new Set();
    let cursor = agent;
    while (cursor !== root) {
      if (!cursor || seen.has(cursor) || ctx.agents.get(cursor.id) !== cursor)
        throw Error('RUN_SESSION_DENIED');
      seen.add(cursor);
      const header = cursor.session.header;
      const parent = ctx.agents.get(header.parentSession);
      if (
        header.origin !== 'subagent' ||
        !parent ||
        !ctx.agents.isOwnedBy(cursor.id, parent)
      )
        throw Error('RUN_SESSION_DENIED');
      cursor = parent;
    }
    return {
      runId: state.runId,
      nativeSessionId: agent.id,
      rootSessionId: root.id,
      parentSessionId:
        agent === root ? null : agent.session.header.parentSession,
      delegationDepth: seen.size,
    };
  }
  function announce(agent) {
    const value = identity(agent);
    identities.set(agent.id, value);
    host.transport.notify('allrice.run-session', value);
  }
  async function checkDirectory(agent, signal) {
    const state = current();
    const cwd = await realpath(
      await ctx.workingDirectory.ensure(agent, signal),
    );
    const path = relative(host.initializeParams.cwd, cwd);
    if (path === '..' || path.startsWith('../') || isAbsolute(path))
      throw Error('RUN_CWD_DENIED');
    if (current() !== state) throw Error('RUN_NOT_ACTIVE');
  }
  function live(agent) {
    const value = identity(agent);
    if (!identities.has(agent.id)) throw Error('RUN_SESSION_DENIED');
    return value;
  }
  ctx.on('subagent/start', (info) => {
    if (info.local) announce(ctx.agents.get(info.id));
  });
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (agent.session.header.origin !== 'subagent') return;
    identity(agent);
    await checkDirectory(agent, signal);
  });
  ctx.on(
    'agent/request',
    ({ agent }, next) => {
      live(agent);
      return next();
    },
    { prepend: true },
  );
  ctx.tools.guard((exec) => {
    try {
      live(exec.agent);
    } catch (error) {
      return error.message;
    }
  });
  ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      const caller = live(exec.agent);
      await checkDirectory(exec.agent, exec.signal);
      await host.transport.request(
        'allrice/run-authorize',
        { ...caller, kind: 'tool' },
        exec.signal,
      );
      live(exec.agent);
      return next();
    },
    { prepend: true },
  );
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      const agent = ctx.agents.get(options.sessionId);
      const caller = live(agent);
      if (
        options.provider !== host.initializeParams.provider ||
        options.model !== host.initializeParams.model
      )
        throw Error('RUN_MODEL_DENIED');
      await checkDirectory(agent, options.signal);
      await host.transport.request(
        'allrice/run-authorize',
        {
          ...caller,
          kind: 'model',
          provider: options.provider,
          model: options.model,
        },
        options.signal,
      );
      live(agent);
      yield* next();
    },
    { prepend: true },
  );
  return {
    async begin({ sessionId, runId }) {
      if (binding || typeof runId !== 'string' || !runId)
        throw Error('RUN_ALREADY_BOUND');
      const record = await host.ensureRoot(sessionId);
      if (binding) throw Error('RUN_ALREADY_BOUND');
      binding = {
        record,
        runId,
        waiting: 0,
        inputClosed: false,
        inputAbort: new AbortController(),
        closing: false,
      };
      identities.clear();
      announce(record.agent);
      for (const agent of ctx.agents.list()) {
        if (agent !== record.agent) announce(agent);
      }
      return { bound: true };
    },
    end(runId) {
      if (binding?.runId !== runId) throw Error('RUN_NOT_ACTIVE');
      closeInput(binding);
      binding = undefined;
      identities.clear();
      return { released: true };
    },
    stop() {
      if (binding) {
        closeInput(binding);
        binding.closing = true;
      }
    },
    closeInput(runId) {
      if (binding?.runId !== runId) throw Error('RUN_NOT_ACTIVE');
      closeInput(binding);
      return { closed: true };
    },
    inputWindow(runId) {
      this.accepting(runId);
      const state = current(runId);
      const signal = state.inputAbort.signal;
      return {
        signal,
        check: () => {
          signal.throwIfAborted();
          if (current(runId) !== state) throw Error('RUN_NOT_ACTIVE');
          this.accepting(runId);
        },
      };
    },
    rootFor(agent) {
      live(agent);
      return current().record.agent;
    },
    hasAdmittedChild(runId) {
      const state = current(runId);
      return [...identities.values()].some(
        (value) =>
          value.runId === state.runId &&
          value.rootSessionId === state.record.agent.id &&
          value.nativeSessionId !== state.record.agent.id &&
          !!value.parentSessionId,
      );
    },
    async authorizeInput(runId) {
      const state = current(runId);
      await host.transport.request('allrice/run-authorize', {
        ...live(state.record.agent),
        kind: 'input',
      });
      if (current(runId) !== state) throw Error('RUN_NOT_ACTIVE');
    },
    attribute(params) {
      const id = params.nativeSessionId ?? ctx.agents.requireInitiator().id;
      const value = identities.get(id);
      if (!value) throw Error('RUN_SESSION_DENIED');
      return { ...params, ...value };
    },
    prompt(runId) {
      const state = current(runId);
      if (state.inputAbort.signal.aborted)
        state.inputAbort = new AbortController();
      state.inputClosed = false;
      return () => {
        if (current(runId) !== state || state.inputClosed)
          throw Error('RUN_COMPLETING');
      };
    },
    accepting(runId, receiptOnly = false) {
      const state = current(runId);
      if (
        !receiptOnly &&
        (state.inputClosed ||
          (state.record.agent.status !== 'running' && !state.waiting))
      )
        throw Error('RUN_COMPLETING');
    },
    async wait(next) {
      const state = current();
      state.waiting++;
      try {
        return await next();
      } finally {
        state.waiting--;
        closeInput(state);
      }
    },
  };
}
