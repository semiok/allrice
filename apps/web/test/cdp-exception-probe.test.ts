import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type { CDPSession } from '../../worker/node_modules/playwright-core/index.js';
import { observeCdpExceptions } from './cdp-exception-probe';

const notPaused = new Error(
  'cdpSession.send: Protocol error (Debugger.resume): Can only perform operation while paused.',
);
const reactError = 'Error: Maximum update depth exceeded';
function fixture() {
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async (_method: string) => ({})),
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

it.each(['Debugger.resumed', 'Debugger.globalObjectCleared'])(
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
  { invalidated: false, error: notPaused, expected: [notPaused] },
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
    if (invalidated) f.cdp.emit('Debugger.globalObjectCleared');
    reject(error);
    await setImmediate();
    expect(f.exceptions).toEqual([reactError]);
    expect(f.failures).toEqual(expected === 'error' ? [error] : expected);
    await f.probe.stop();
  },
);

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
  f.cdp.emit('Debugger.globalObjectCleared');
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
