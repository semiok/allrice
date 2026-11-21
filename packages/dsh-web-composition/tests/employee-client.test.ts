import { expect, it } from 'vitest';
import { EmployeeClientNavigation } from '../src/employee-client.mjs';

const selection = (
  employeeInstanceId: string,
  threadId = 'same-native-id',
) => ({ employeeInstanceId, threadId });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it('opens same-Host threads natively but closes all old resources before another employee/revision mounts', async () => {
  const events: string[] = [];
  let revision = 1;
  const navigation = new EmployeeClientNavigation({
    admit: async (input) => ({
      mount: { remountKey: `${input.employeeInstanceId}/${revision}` },
      nativeSessionId: input.threadId!,
    }),
    create: async (mount, signal) => {
      events.push(`create:${mount.remountKey}`);
      return {
        openSession: (id) => {
          events.push(`open:${id}`);
        },
        abort: () => {
          expect(signal.aborted).toBe(true);
          events.push('abort:http/ws/resource');
        },
        releaseSessionReferences: () => {
          events.push('release:references');
        },
        destroy: () => {
          events.push('destroy:client/cordis');
        },
      };
    },
  });
  await navigation.select(selection('rice', 'one'));
  await navigation.select(selection('rice', 'two'));
  expect(events).toEqual(['create:rice/1', 'open:one', 'open:two']);
  await navigation.select(selection('writer', 'two'));
  revision++;
  await navigation.select(selection('writer', 'two'));
  expect(events.slice(3)).toEqual([
    'abort:http/ws/resource',
    'release:references',
    'destroy:client/cordis',
    'create:writer/1',
    'open:two',
    'abort:http/ws/resource',
    'release:references',
    'destroy:client/cordis',
    'create:writer/2',
    'open:two',
  ]);
  await navigation.dispose();
});

it('never mounts a superseded admission and does not replay the old thread on its replacement', async () => {
  const entered = deferred(),
    answer = deferred<{
      mount: { remountKey: string };
      nativeSessionId: string;
    }>();
  const events: string[] = [];
  let oldSignal: AbortSignal | undefined;
  const navigation = new EmployeeClientNavigation({
    admit: async (input, signal) => {
      if (input.employeeInstanceId === 'rice') {
        oldSignal = signal;
        entered.resolve();
        return answer.promise;
      }
      return { mount: { remountKey: 'writer' }, nativeSessionId: 'new' };
    },
    create: async (mount) => ({
      openSession: (id) => {
        events.push(`${mount.remountKey}:${id}`);
      },
      abort() {},
      releaseSessionReferences() {},
      destroy() {},
    }),
  });
  const old = navigation.select(selection('rice'));
  await entered.promise;
  const current = navigation.select(selection('writer'));
  expect(oldSignal!.aborted).toBe(true);
  answer.resolve({ mount: { remountKey: 'rice' }, nativeSessionId: 'old' });
  expect(await old).toBe('superseded');
  expect(await current).toBe('opened');
  expect(events).toEqual(['writer:new']);
  await navigation.dispose();
});

it('waits for actual old-root disposal and stops mounting if teardown fails', async () => {
  const entered = deferred(),
    finish = deferred();
  const events: string[] = [];
  const navigation = new EmployeeClientNavigation({
    admit: async (input) => ({
      mount: { remountKey: input.employeeInstanceId },
      nativeSessionId: 'same-native-id',
    }),
    create: async (mount) => {
      events.push(`create:${mount.remountKey}`);
      return {
        openSession() {},
        abort() {
          events.push('abort');
        },
        releaseSessionReferences() {
          events.push('release');
        },
        async destroy() {
          events.push('destroy:start');
          entered.resolve();
          await finish.promise;
          throw new Error('root still live');
        },
      };
    },
  });
  await navigation.select(selection('rice'));
  const next = navigation.select(selection('writer'));
  const failed = expect(next).rejects.toThrow('Previous client did not close');
  await entered.promise;
  expect(events).toEqual(['create:rice', 'abort', 'release', 'destroy:start']);
  finish.resolve();
  await failed;
  const failure = await next.catch((error: unknown) => error);
  await expect(navigation.select(selection('other'))).rejects.toThrow(
    'Previous client did not close',
  );
  expect(events.filter((entry) => entry.startsWith('create:'))).toEqual([
    'create:rice',
  ]);
  await expect(navigation.dispose()).rejects.toBe(failure);
  await expect(navigation.dispose()).rejects.toBe(failure);
  expect(events).toEqual(['create:rice', 'abort', 'release', 'destroy:start']);
});

it('leaves no old client after admission is denied, preserving the original owner error', async () => {
  const denied = new Error('DEPENDENCY_UNAVAILABLE: mount not bound');
  const events: string[] = [];
  const navigation = new EmployeeClientNavigation({
    admit: async (input) => {
      if (input.threadId === 'denied') throw denied;
      return {
        mount: { remountKey: 'rice' },
        nativeSessionId: input.threadId!,
      };
    },
    create: async () => ({
      openSession() {},
      abort() {
        events.push('abort');
      },
      releaseSessionReferences() {
        events.push('release');
      },
      destroy() {
        events.push('destroy');
      },
    }),
  });
  await navigation.select(selection('rice'));
  await expect(navigation.select(selection('rice', 'denied'))).rejects.toBe(
    denied,
  );
  expect(events).toEqual(['abort', 'release', 'destroy']);
  await navigation.dispose();
});

it('supersedes a selection during teardown before sending its obsolete admission', async () => {
  const entered = deferred(),
    finish = deferred();
  const admitted: string[] = [];
  const navigation = new EmployeeClientNavigation({
    admit: async (input) => {
      admitted.push(input.employeeInstanceId);
      return {
        mount: { remountKey: input.employeeInstanceId },
        nativeSessionId: 'same-native-id',
      };
    },
    create: async (mount) => ({
      openSession() {},
      abort() {},
      releaseSessionReferences() {},
      async destroy() {
        if (mount.remountKey === 'rice') {
          entered.resolve();
          await finish.promise;
        }
      },
    }),
  });
  await navigation.select(selection('rice'));
  const obsolete = navigation.select(selection('obsolete'));
  await entered.promise;
  const latest = navigation.select(selection('latest'));
  finish.resolve();
  expect(await obsolete).toBe('superseded');
  expect(await latest).toBe('opened');
  expect(admitted).toEqual(['rice', 'latest']);
  await navigation.dispose();
});

it('aborts a root being created and disposes its late result before resolving supersession', async () => {
  const entered = deferred(),
    finish = deferred();
  let signal: AbortSignal | undefined;
  const events: string[] = [];
  const navigation = new EmployeeClientNavigation({
    admit: async () => ({
      mount: { remountKey: 'rice' },
      nativeSessionId: 'same-native-id',
    }),
    create: async (_mount, lifetime) => {
      signal = lifetime;
      entered.resolve();
      await finish.promise;
      return {
        openSession() {
          events.push('unexpected-open');
        },
        abort() {
          events.push('abort');
        },
        releaseSessionReferences() {
          events.push('release');
        },
        destroy() {
          events.push('destroy');
        },
      };
    },
  });
  const opening = navigation.select(selection('rice'));
  await entered.promise;
  const closing = navigation.dispose();
  expect(signal!.aborted).toBe(true);
  finish.resolve();
  expect(await opening).toBe('superseded');
  await closing;
  expect(events).toEqual(['abort', 'release', 'destroy']);
  await expect(navigation.select(selection('rice'))).rejects.toThrow(
    'disposed',
  );
});

it('rejects dispose with the saved failure when a cancelled late root cannot be destroyed', async () => {
  const entered = deferred(),
    finish = deferred();
  const cause = new Error('late root still live');
  const events: string[] = [];
  const navigation = new EmployeeClientNavigation({
    admit: async () => ({
      mount: { remountKey: 'rice' },
      nativeSessionId: 'same-native-id',
    }),
    create: async () => {
      entered.resolve();
      await finish.promise;
      return {
        openSession() {
          events.push('unexpected-open');
        },
        abort() {
          events.push('abort');
        },
        releaseSessionReferences() {
          events.push('release');
        },
        destroy() {
          events.push('destroy');
          throw cause;
        },
      };
    },
  });
  const opening = navigation.select(selection('rice'));
  await entered.promise;
  const closing = navigation.dispose();
  const rejection = closing.catch((error: AggregateError) => error);
  finish.resolve();
  expect(await opening).toBe('superseded');
  const failure = await rejection;
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([cause]);
  await expect(navigation.dispose()).rejects.toBe(failure);
  expect(events).toEqual(['abort', 'release', 'destroy']);
});
