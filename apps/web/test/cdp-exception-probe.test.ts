import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type { CDPSession } from 'playwright-core';
import { observeCdpExceptions } from './cdp-exception-probe';

const notPaused = new Error(
  'cdpSession.send: Protocol error (Debugger.resume): Can only perform operation while paused.',
);
const reactError = 'Error: Maximum update depth exceeded';
function fixture() {
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async () => ({})),
  });
  const exceptions: string[] = [];
  const failures: unknown[] = [];
  const probe = observeCdpExceptions(
    cdp as unknown as CDPSession,
    (error) => exceptions.push(error),
    (error) => failures.push(error),
  );
  const pause = () =>
    cdp.emit('Debugger.paused', { data: { description: reactError } });
  return { cdp, exceptions, failures, probe, pause };
}

it('only resumes an observed pause and retains caught React exceptions', async () => {
  const f = fixture();
  await setImmediate();
  expect(f.cdp.send).not.toHaveBeenCalled();
  f.pause();
  await setImmediate();
  expect(f.cdp.send).toHaveBeenCalledExactlyOnceWith('Debugger.resume');
  expect(f.exceptions).toEqual([reactError]);
  expect(f.failures).toEqual([]);
  await f.probe.stop();
});

it.each(['Debugger.resumed', 'Runtime.executionContextsCleared'])(
  'does not resume a queued pause invalidated by %s',
  async (event) => {
    const f = fixture();
    f.pause();
    f.cdp.emit(event);
    await setImmediate();
    expect(f.cdp.send).not.toHaveBeenCalled();
    expect(f.exceptions).toEqual([reactError]);
    expect(f.failures).toEqual([]);
    await f.probe.stop();
  },
);

it.each([
  { invalidated: true, error: notPaused, expected: [] },
  {
    invalidated: true,
    error: new Error('transport failed'),
    expected: 'error',
  },
])(
  'requires navigation evidence for an in-flight stale resume: $invalidated / $error',
  async ({ invalidated, error, expected }) => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.cdp.send.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    f.pause();
    await setImmediate();
    if (invalidated) f.cdp.emit('Runtime.executionContextsCleared');
    reject(error);
    await setImmediate();
    expect(f.exceptions).toEqual([reactError]);
    expect(f.failures).toEqual(expected === 'error' ? [error] : expected);
    await f.probe.stop();
  },
);

it('cannot pass a stale-resume check until its invalidation event arrives', async () => {
  const f = fixture();
  f.cdp.send.mockRejectedValueOnce(notPaused);
  f.pause();
  let drained = false;
  const drain = f.probe.drain().then(() => {
    drained = true;
  });
  await setImmediate();
  expect(drained).toBe(false);
  expect(f.exceptions).toEqual([reactError]);
  f.cdp.emit('Runtime.executionContextsCleared');
  await drain;
  expect(drained).toBe(true);
  expect(f.failures).toEqual([]);
  await f.probe.stop();
});

it('serializes resumes and does not let a new pause hide an earlier failure', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.cdp.send.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  f.pause();
  await setImmediate();
  f.cdp.emit('Runtime.executionContextsCleared');
  f.pause();
  await setImmediate();
  expect(f.cdp.send).toHaveBeenCalledTimes(1);
  const failure = new Error('transport failed');
  reject(failure);
  await setImmediate();
  expect(f.cdp.send).toHaveBeenCalledTimes(2);
  expect(f.exceptions).toEqual([reactError, reactError]);
  expect(f.failures).toEqual([failure]);
  await f.probe.stop();
});

it('stops queued resumes when fixture cleanup begins', async () => {
  const f = fixture();
  f.pause();
  await f.probe.stop();
  expect(f.cdp.send).not.toHaveBeenCalled();
  expect(f.exceptions).toEqual([reactError]);
});
