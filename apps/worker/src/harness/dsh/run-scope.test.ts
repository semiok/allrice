import { expect, it } from 'vitest';
import type {
  DshNotification,
  DshProtocolClient,
} from '../dsh-protocol-client.js';
import { nativeRunScope } from './run-scope.js';

it('only accepts ordered root/child start attribution from this owned Run', () => {
  let notice!: (value: DshNotification) => void;
  const scope = nativeRunScope(
    {
      subscribe: (listener: typeof notice) => {
        notice = listener;
        return () => {};
      },
    } as DshProtocolClient,
    'root',
    'run',
  );
  const root = {
    runId: 'run',
    rootSessionId: 'root',
    nativeSessionId: 'root',
    parentSessionId: null,
    delegationDepth: 0,
  };
  const child = {
    ...root,
    nativeSessionId: 'child',
    parentSessionId: 'root',
    delegationDepth: 1,
  };
  expect(() => scope.check(child)).toThrow('原生调用不属于当前运行');
  const start = (params: Record<string, unknown>) =>
    notice({ method: 'allrice.run-session', params });
  start(child);
  expect(() => scope.check(child)).toThrow();
  start(root);
  start(child);
  expect(scope.check({ ...child, action: 'check' })).toEqual({
    nativeSessionId: 'child',
    action: 'check',
  });
  for (const forged of [
    { runId: 'other' },
    { rootSessionId: 'other-tenant' },
    { parentSessionId: 'foreign' },
    { delegationDepth: 0 },
  ])
    expect(() => scope.check({ ...child, ...forged })).toThrow();
  start({ ...child, nativeSessionId: 'forged', parentSessionId: 'missing' });
  expect(() => scope.check({ ...child, nativeSessionId: 'forged' })).toThrow();
});
