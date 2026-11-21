import type postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createPostgresModelGatewayStore } from './postgres-store.ts';

/** Mirrors only postgres 3.4.9's documented LISTEN callbacks and the observed
 * identity replacement on reconnect. Actual PG reconnect is a separate DB test. */
function listenerPoolFixture() {
  type Listener = { notify: (person: string) => void; ready: () => void };
  let listeners = new Set<Listener>();
  let registrations = 0;
  const db = {
    async listen(
      _channel: string,
      notify: Listener['notify'],
      ready: Listener['ready'],
    ) {
      registrations++;
      const listener = { notify, ready };
      listeners.add(listener);
      ready();
      return {
        async unlisten() {
          listeners.delete(listener);
        },
      };
    },
  } as unknown as postgres.Sql;
  return {
    db,
    get registrations() {
      return registrations;
    },
    get listenerCount() {
      return listeners.size;
    },
    reconnect() {
      listeners = new Set([...listeners].map((l) => ({ ...l })));
      for (const l of listeners) l.ready();
    },
    notify(person: string) {
      for (const l of listeners) l.notify(person);
    },
    end() {
      listeners.clear();
    },
  };
}

describe('capacity watcher ownership with postgres 3.4.9 reconnect semantics', () => {
  it('one pool listener survives reconnect; ended waiters remove their local callbacks', async () => {
    const pool = listenerPoolFixture();
    const first = createPostgresModelGatewayStore(pool.db);
    const second = createPostgresModelGatewayStore(pool.db);
    const signal = new AbortController().signal;
    const a = await first.watchCapacity('person', signal);
    const b = await second.watchCapacity('person', signal);
    await a.wait();
    await b.wait();
    pool.reconnect();
    await a.wait();
    await b.wait();
    await a.close();
    const awake = b.wait();
    pool.notify('person');
    await awake;
    await b.close();
    for (let index = 0; index < 100; index++) {
      const watch = await first.watchCapacity('person', signal);
      await watch.wait();
      pool.reconnect();
      await watch.wait();
      await watch.close();
    }
    expect(pool.registrations).toBe(1);
    expect(pool.listenerCount).toBe(1); // Explicit pool owner, not a waiter leak.
    pool.notify('person');
    await expect(a.wait()).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
    await expect(b.wait()).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
    pool.end();
    expect(pool.listenerCount).toBe(0);
  });
});
