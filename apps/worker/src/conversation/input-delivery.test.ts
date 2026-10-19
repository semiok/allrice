import { afterEach, expect, it, vi } from 'vitest';
import type { HarnessAdapter } from '../harness/adapter.js';
import { HandlerError } from '../errors.js';
import {
  createConversationInputDelivery,
  isAssistantCompleting,
  pollEmployeeConversationSteers,
} from './turn-lifecycle.js';

const db = vi.hoisted(() => ({
  claim: vi.fn(),
  consume: vi.fn(),
  defer: vi.fn(),
  reject: vi.fn(),
}));
vi.mock('@allrice/database', () => ({
  claimConversationSteer: db.claim,
  consumeConversationSteer: db.consume,
  deferConversationSteer: db.defer,
  rejectConversationSteer: db.reject,
  bindConversationThread: vi.fn(),
  recordConversationTurn: vi.fn(),
}));
const controllers: ReturnType<typeof createConversationInputDelivery>[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  vi.clearAllMocks();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const ownership = {
  organizationId: 'org',
  workspaceId: 'workspace',
  sessionId: 'session',
  runId: 'run',
  workerId: 'worker',
};
const scope = { threadId: 'native', turnId: 'native:turn:1' };
const command = (typed = true) => ({
  id: 'original-command',
  followupRunId: 'original-followup',
  clientUserMessageId: 'original-input',
  message: 'unchanged real user text',
  inputKind: typed ? 'steer_current' : null,
});
function controller(
  extra: Partial<Parameters<typeof createConversationInputDelivery>[0]> = {},
) {
  const c = createConversationInputDelivery({
    ...scope,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 60_000,
    isCurrent: () => true,
    handoff: async () => {},
    ...extra,
  });
  controllers.push(c);
  return c;
}
function poll(
  steer = vi.fn(),
  extra: Partial<Parameters<typeof pollEmployeeConversationSteers>[0]> = {},
) {
  return pollEmployeeConversationSteers({
    ownership,
    generation: 7,
    ...scope,
    signal: new AbortController().signal,
    adapter: {
      kind: 'dsh',
      capabilities: { steer: true },
      steer,
    } as unknown as HarnessAdapter,
    polling: () => false,
    drain: true,
    ...extra,
  });
}

it.each([true, false])(
  'stops the next claim synchronously and defers an in-flight claim without steering (typed=%s)',
  async (typed) => {
    const claimed = deferred<ReturnType<typeof command>>();
    db.claim.mockReturnValueOnce(claimed.promise);
    const c = controller(),
      steer = vi.fn();
    const loop = poll(steer, { delivery: c });
    const hold = c.pause(scope);
    let settled = false;
    void hold.settled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(c.enter(scope)).toBeUndefined();
    claimed.resolve(command(typed));
    await loop;
    await hold.settled;
    expect(db.claim).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
    expect(db.defer).toHaveBeenCalledWith({
      commandId: 'original-command',
      workerId: 'worker',
    });
    expect(db.consume).not.toHaveBeenCalled();
    expect(db.reject).not.toHaveBeenCalled();
    await hold.resumeBeforeTurnClose();
    expect(c.paused()).toBe(false);
  },
);

it('waits through the real steer promise and original command settlement before acknowledging pause', async () => {
  const steered = deferred<unknown>(),
    consumed = deferred<unknown>();
  const enteredSteer = deferred<void>();
  db.claim.mockResolvedValueOnce(command());
  db.consume.mockReturnValueOnce(consumed.promise);
  const c = controller();
  const loop = poll(
    vi.fn(() => {
      enteredSteer.resolve();
      return steered.promise;
    }),
    { delivery: c },
  );
  await enteredSteer.promise;
  const hold = c.pause(scope);
  let settled = false;
  void hold.settled.then(() => {
    settled = true;
  });
  steered.resolve({
    status: 'adopted',
    inputId: 'original-input',
    messageId: 'native-message',
    sequence: 9,
    turnId: scope.turnId,
    checkpoint: 'step_user_message',
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  consumed.resolve(undefined);
  await loop;
  await hold.settled;
  expect(db.consume).toHaveBeenCalledTimes(1);
  expect(settled).toBe(true);
});

it('defers the same command if the original turn or lease signal closes while claim is pending', async () => {
  const claim = deferred<ReturnType<typeof command>>();
  db.claim.mockReturnValueOnce(claim.promise);
  const c = controller(),
    steer = vi.fn();
  const loop = poll(steer, { delivery: c });
  c.dispose();
  claim.resolve(command());
  await loop;
  expect(steer).not.toHaveBeenCalled();
  expect(db.defer).toHaveBeenCalledWith({
    commandId: 'original-command',
    workerId: 'worker',
  });
  expect(db.consume).not.toHaveBeenCalled();
  expect(db.reject).not.toHaveBeenCalled();
});

it.each([true, false])(
  'defers exact ASSISTANT_COMPLETING for typed and legacy commands (typed=%s)',
  async (typed) => {
    db.claim.mockResolvedValueOnce(command(typed));
    await poll(
      vi
        .fn()
        .mockRejectedValue(
          new HandlerError(
            'ASSISTANT_COMPLETING',
            'ASSISTANT_COMPLETING',
            false,
          ),
        ),
    );
    expect(db.defer).toHaveBeenCalledTimes(1);
    expect(db.reject).not.toHaveBeenCalled();
    expect(db.consume).not.toHaveBeenCalled();
  },
);

it.each([
  [new Error('ASSISTANT_COMPLETING'), true],
  [new Error('prefix ASSISTANT_COMPLETING suffix'), false],
  [Object.assign(new Error('ASSISTANT_COMPLETING'), { code: 'OTHER' }), false],
  [
    Object.assign(new Error('different message'), {
      code: 'ASSISTANT_COMPLETING',
    }),
    true,
  ],
])(
  'uses structured code before exact legacy message (%s)',
  (error, expected) => {
    expect(isAssistantCompleting(error)).toBe(expected);
  },
);

it('keeps other legacy rejection behavior', async () => {
  db.claim.mockResolvedValueOnce(command(false));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await poll(
    vi
      .fn()
      .mockRejectedValue(
        Object.assign(Error('ASSISTANT_COMPLETING'), { code: 'OTHER' }),
      ),
  );
  expect(db.reject).toHaveBeenCalledWith({
    commandId: 'original-command',
    workerId: 'worker',
    errorCode: 'STEER_REJECTED',
  });
  expect(db.defer).not.toHaveBeenCalled();
  log.mockRestore();
});

it.each([true, false])(
  'preserves pending input only in same-turn handoff; old drain stays strict (handoff=%s)',
  async (handoff) => {
    db.claim.mockResolvedValueOnce(command()).mockResolvedValue(null);
    await poll(
      vi.fn().mockResolvedValue({
        status: 'pending',
        inputId: 'original-input',
        messageId: 'native-message',
      }),
      { handoff },
    );
    expect(db.defer).toHaveBeenCalledTimes(handoff ? 1 : 0);
    expect(db.reject).toHaveBeenCalledTimes(handoff ? 0 : 1);
    expect(db.consume).not.toHaveBeenCalled();
  },
);

it('hands off exclusively before releasing the background poller', async () => {
  const entered = deferred<void>(),
    finish = deferred<void>();
  const c: ReturnType<typeof controller> = controller({
    handoff: async () => {
      expect(c.enter(scope)).toBeUndefined();
      const leave = c.enter({ ...scope, handoff: true });
      expect(leave).toBeTypeOf('function');
      entered.resolve();
      await finish.promise;
      leave!();
    },
  });
  const hold = c.pause(scope);
  await hold.settled;
  const release = hold.resumeBeforeTurnClose();
  await entered.promise;
  expect(c.enter(scope)).toBeUndefined();
  finish.resolve();
  await release;
  const leave = c.enter(scope);
  expect(leave).toBeTypeOf('function');
  leave!();
});

it('cancellation rejects an unsettled pause and removes the local stop flag', async () => {
  const abort = new AbortController(),
    c = controller({ signal: abort.signal });
  const leave = c.enter(scope)!;
  const hold = c.pause(scope);
  abort.abort();
  await expect(hold.settled).rejects.toThrow('INPUT_GATE_SCOPE_CHANGED');
  expect(c.paused()).toBe(false);
  expect(c.enter(scope)).toBeUndefined();
  leave();
});

it('original deadline cannot be extended by a gate request', async () => {
  vi.useFakeTimers();
  const c = controller({ deadlineAt: Date.now() + 50 }),
    leave = c.enter(scope)!;
  const hold = c.pause(scope);
  const rejected = expect(hold.settled).rejects.toThrow(
    'INPUT_GATE_SCOPE_CHANGED',
  );
  await vi.advanceTimersByTimeAsync(51);
  await rejected;
  hold.dispose();
  leave();
  expect(() => c.pause(scope)).toThrow('INPUT_GATE_SCOPE_CHANGED');
  const normal = c.enter(scope);
  expect(normal).toBeTypeOf('function');
  normal!();
});

it('rejects another turn and restores the flag when handoff fails', async () => {
  const c = controller({
    handoff: async () => {
      throw Error('handoff failed');
    },
  });
  expect(() => c.pause({ ...scope, turnId: 'native:turn:2' })).toThrow(
    'INPUT_GATE_SCOPE_CHANGED',
  );
  const hold = c.pause(scope);
  await hold.settled;
  await expect(hold.resumeBeforeTurnClose()).rejects.toThrow('handoff failed');
  expect(c.paused()).toBe(false);
  const leave = c.enter(scope);
  expect(leave).toBeTypeOf('function');
  leave!();
});
