/** Real isolated PostgreSQL, no model/VM/service/credentials. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import type { Socket } from 'node:net';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ModelAttemptReceipt,
  ModelAttemptStart,
  ModelCallBinding,
} from './contract.ts';
import { createPostgresModelGatewayStore } from './postgres-store.ts';
import { unknownUsage } from './usage.ts';
import { deferred, freshCall, modelBinding } from './gateway.fixture.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'MET268 owner storage: multiple independent PG stores and global person slots',
  () => {
    let admin: postgres.Sql;
    let firstDb: postgres.Sql;
    let secondDb: postgres.Sql;
    let first: ReturnType<typeof createPostgresModelGatewayStore>;
    let second: ReturnType<typeof createPostgresModelGatewayStore>;
    let databaseUrl: string;
    const schema = 'met268_' + randomUUID().replaceAll('-', '_');
    beforeAll(async () => {
      const value = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!value) throw Error('Dedicated test database required');
      const url = new URL(value);
      databaseUrl = value;
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        url.hostname !== '127.0.0.1' ||
        url.search ||
        url.hash ||
        !(
          (url.port === '5432' &&
            url.username === 'a123' &&
            url.pathname === '/allrice_b2') ||
          (url.port === '54329' &&
            url.username === 'allrice' &&
            url.pathname === '/allrice')
        )
      )
        throw Error('Dedicated test database required');
      admin = postgres(value, { max: 1 });
      await admin.unsafe(`create schema ${schema}`);
      firstDb = postgres(value, {
        max: 12,
        connection: { search_path: schema },
      });
      secondDb = postgres(value, {
        max: 12,
        connection: { search_path: schema },
      });
      await firstDb.unsafe(
        await readFile(
          new URL(
            '../../database/migrations/0248_model_gateway_attempts.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      first = createPostgresModelGatewayStore(firstDb);
      second = createPostgresModelGatewayStore(secondDb);
    });
    afterAll(async () => {
      await Promise.all([
        firstDb?.end({ timeout: 5 }),
        secondDb?.end({ timeout: 5 }),
      ]);
      if (admin) {
        await admin.unsafe(`drop schema ${schema} cascade`);
        await admin.end({ timeout: 5 });
      }
    });
    async function attempt(
      binding: ModelCallBinding,
      store = first,
      ownerId: string = randomUUID(),
    ): Promise<ModelAttemptStart> {
      const callId = await store.claimCall(
        freshCall(binding),
        'sha256:synthetic',
      );
      return {
        id: randomUUID(),
        callId,
        personId: binding.vm.personId,
        ownerId,
        kind: 'model',
        protocol: 'openai-chat-completions',
      };
    }
    const closed = (start: ModelAttemptStart): ModelAttemptReceipt => ({
      ...start,
      dispatchObserved: true,
      httpStatus: 200,
      terminal: 'completed',
      outcome: 'closed',
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        cachedInputTokens: null,
        usageComplete: true,
        cacheUsageKnown: false,
      },
    });

    it('16个并发申请跨两个store和企业，同person只能取得8个，另一个person不受影响', async () => {
      const binding = modelBinding();
      const otherOrg = modelBinding(binding.vm.personId, randomUUID());
      const starts = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          attempt(index % 2 ? binding : otherOrg, index % 2 ? first : second),
        ),
      );
      const results = await Promise.all(
        starts.map((start, index) =>
          (index % 2 ? first : second).tryStartAttempt(start),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(8);
      const [count] = await firstDb<
        { count: number }[]
      >`select count(*)::int as count from allrice_model_gateway_slots where person_id=${binding.vm.personId}`;
      expect(count?.count).toBe(8);
      const other = await attempt(modelBinding(), second);
      expect(await second.tryStartAttempt(other)).toBe(true);
      await second.finishAttempt(closed(other));
      for (let index = 0; index < starts.length; index++)
        if (results[index]) await first.finishAttempt(closed(starts[index]!));
    });

    it('先订阅再重查保证release与wait之间不丢通知，真实receipt提交后才放slot', async () => {
      const binding = modelBinding();
      const starts = await Promise.all(
        Array.from({ length: 9 }, () => attempt(binding)),
      );
      for (const start of starts.slice(0, 8))
        expect(await first.tryStartAttempt(start)).toBe(true);
      const signal = new AbortController();
      const watch = await second.watchCapacity(
        binding.vm.personId,
        signal.signal,
      );
      try {
        await watch.wait(); // initial LISTEN generation notification
        expect(await second.tryStartAttempt(starts[8]!)).toBe(false);
        await first.finishAttempt(closed(starts[0]!));
        await watch.wait(); // notification happened before this wait
        expect(await second.tryStartAttempt(starts[8]!)).toBe(true);
      } finally {
        await watch.close();
      }
      for (const start of starts.slice(1))
        await first.finishAttempt(closed(start));
    });

    it('两个store对同native call只有一个claim，body变更/重连不产生新派发资格', async () => {
      const binding = modelBinding();
      const results = await Promise.allSettled([
        first.claimCall(binding, 'sha256:a'),
        second.claimCall(binding, 'sha256:b'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { code: 'DUPLICATE_CALL' },
      });
    });

    it('真实LISTEN backend重连后，结束的waiter不累积driver listener，pool结束释放长期监听', async () => {
      const applicationName = 'met268-listen-' + randomUUID();
      const db = postgres(databaseUrl, {
        max: 1,
        connection: { search_path: schema, application_name: applicationName },
      });
      const reconnected = deferred();
      let generations = 0;
      let registrations = 0;
      let listenerPid = 0;
      const observed = new Proxy(db, {
        get(target, key, receiver) {
          if (key !== 'listen') return Reflect.get(target, key, receiver);
          return async (...args: Parameters<typeof db.listen>) => {
            registrations++;
            const listener = await db.listen(args[0], args[1], () => {
              args[2]?.();
              if (++generations === 2) reconnected.resolve();
            });
            listenerPid = listener.state.pid;
            return listener;
          };
        },
      }) as postgres.Sql;
      const store = createPostgresModelGatewayStore(observed);
      const person = randomUUID();
      const signal = new AbortController().signal;
      const watch = await store.watchCapacity(person, signal);
      try {
        await watch.wait();
        await admin`select pg_terminate_backend(${listenerPid})`;
        await reconnected.promise;
        await watch.wait();
        await watch.close();
        // The driver listener is deliberately pool-owned; replacing 100 local
        // watchers after reconnect must not register 100 unreleasable listeners.
        for (let index = 0; index < 100; index++) {
          const next = await store.watchCapacity(person, signal);
          await next.wait();
          const notified = next.wait();
          await firstDb.notify('allrice_model_gateway_capacity', person);
          await notified;
          await next.close();
        }
        expect(registrations).toBe(1);
        await expect(watch.wait()).rejects.toMatchObject({
          code: 'ADMISSION_CLOSED',
        });
      } finally {
        await watch.close();
        await db.end({ timeout: 5 });
      }
      const [remaining] = await admin<
        { count: number }[]
      >`select count(*)::int as count
        from pg_stat_activity where application_name=${applicationName}`;
      expect(remaining?.count).toBe(0);
    });

    it('真实初次连接失败后同一LISTEN owner恢复；取消等待者不新注册driver callback', async () => {
      const target = new URL(databaseUrl);
      let accepting = false;
      let rejectedConnections = 0;
      const sockets = new Set<Socket>();
      const proxy = createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        if (!accepting) {
          rejectedConnections++;
          socket.destroy();
          return;
        }
        const upstream = createConnection({
          host: target.hostname,
          port: Number(target.port || 5432),
        });
        sockets.add(upstream);
        upstream.once('close', () => {
          sockets.delete(upstream);
          socket.destroy();
        });
        upstream.on('error', () => socket.destroy());
        socket.once('close', () => upstream.destroy());
        socket.pipe(upstream).pipe(socket);
      });
      await new Promise<void>((resolve) =>
        proxy.listen(0, '127.0.0.1', resolve),
      );
      const address = proxy.address();
      if (!address || typeof address === 'string')
        throw Error('fixture proxy missing');
      const routed = new URL(databaseUrl);
      routed.port = String(address.port);
      const applicationName = 'met268-initial-listen-' + randomUUID();
      const db = postgres(routed.toString(), {
        max: 1,
        connection: { search_path: schema, application_name: applicationName },
      });
      let registrations = 0;
      const observed = new Proxy(db, {
        get(target, key, receiver) {
          if (key !== 'listen') return Reflect.get(target, key, receiver);
          return (...args: Parameters<typeof db.listen>) => {
            registrations++;
            return db.listen(...args);
          };
        },
      }) as postgres.Sql;
      const store = createPostgresModelGatewayStore(observed);
      const person = randomUUID();
      let watch: Awaited<ReturnType<typeof store.watchCapacity>> | undefined;
      try {
        await expect(
          store.watchCapacity(person, new AbortController().signal),
        ).rejects.toBeInstanceOf(Error);
        expect(rejectedConnections).toBeGreaterThan(0);
        const controller = new AbortController();
        const canceled = store.watchCapacity(person, controller.signal);
        controller.abort(
          new Error('synthetic disconnected queue cancellation'),
        );
        await expect(canceled).rejects.toThrow(
          'synthetic disconnected queue cancellation',
        );
        accepting = true;
        watch = await store.watchCapacity(person, new AbortController().signal);
        await watch.wait();
        const notified = watch.wait();
        await firstDb.notify('allrice_model_gateway_capacity', person);
        await notified;
        expect(registrations).toBe(1);
        await watch.close();
        await expect(watch.wait()).rejects.toMatchObject({
          code: 'ADMISSION_CLOSED',
        });
      } finally {
        await watch?.close();
        await db.end({ timeout: 5 });
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
      const [remaining] = await admin<
        { count: number }[]
      >`select count(*)::int as count from pg_stat_activity where application_name=${applicationName}`;
      expect(remaining?.count).toBe(0);
    });

    it('重启只读未知intent保留null；时间流逝不释放slot，可信死进程恢复才释放', async () => {
      const binding = modelBinding();
      const owner = randomUUID();
      const starts = await Promise.all(
        Array.from({ length: 9 }, () => attempt(binding, first, owner)),
      );
      for (const start of starts.slice(0, 8))
        await first.tryStartAttempt(start);
      await firstDb`update allrice_model_gateway_slots set acquired_at=clock_timestamp()-interval '30 days' where person_id=${binding.vm.personId}`;
      const restarted = createPostgresModelGatewayStore(secondDb);
      expect(await restarted.tryStartAttempt(starts[8]!)).toBe(false);
      expect(
        await restarted.usage(binding.vm.personId, binding.vm.organizationId),
      ).toMatchObject({
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cachedInputTokens: null,
        usageComplete: false,
        attemptCount: 8,
        receiptCount: 0,
      });
      expect(
        await restarted.reconcileOwner(
          randomUUID(),
          'host-proof:other-dead-process',
        ),
      ).toBe(0);
      await expect(restarted.reconcileOwner(owner, '')).rejects.toMatchObject({
        code: 'AUTHORIZATION_DENIED',
      });
      expect(
        await restarted.reconcileOwner(owner, 'host-proof:exact-dead-process'),
      ).toBe(8);
      expect(await restarted.tryStartAttempt(starts[8]!)).toBe(true);
      const original = await restarted.attempts(starts[0]!.callId);
      expect(original[0]).toMatchObject({
        outcome: 'unknown',
        dispatchObserved: null,
        usage: unknownUsage(),
      });
      await restarted.finishAttempt(closed(starts[8]!));
    });

    it('receipt事务失败保留原始intent和slot，重复事实幂等而冲突事实拒绝', async () => {
      const binding = modelBinding();
      const start = await attempt(binding);
      await first.tryStartAttempt(start);
      await firstDb.unsafe(`create function fail_meter_receipt() returns trigger language plpgsql as $$ begin
      if new.id='${start.id}' then raise exception 'synthetic receipt disk failure'; end if; return new; end $$;
      create trigger fail_meter_receipt before update on allrice_model_gateway_attempts for each row execute function fail_meter_receipt()`);
      try {
        await expect(second.finishAttempt(closed(start))).rejects.toThrow(
          'synthetic receipt disk failure',
        );
      } finally {
        await firstDb.unsafe(
          'drop trigger fail_meter_receipt on allrice_model_gateway_attempts; drop function fail_meter_receipt()',
        );
      }
      expect(await first.attempts(start.callId)).toMatchObject([
        { outcome: 'unknown' },
      ]);
      const [slot] =
        await firstDb`select attempt_id from allrice_model_gateway_slots where attempt_id=${start.id}`;
      expect(slot).toBeDefined();
      await first.finishAttempt(closed(start));
      await second.finishAttempt(closed(start));
      await expect(
        second.finishAttempt({ ...closed(start), httpStatus: 201 }),
      ).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' });
      await expect(
        firstDb`update allrice_model_gateway_calls set request_digest='changed' where id=${start.callId}`,
      ).rejects.toThrow('immutable');
    });

    it('unknown关闭保留已观察事实与slot，可信owner恢复只补一次旁证且不改raw receipt', async () => {
      const binding = modelBinding();
      const start = await attempt(binding);
      await first.tryStartAttempt(start);
      const receipt: ModelAttemptReceipt = {
        ...closed(start),
        terminal: 'failed',
        outcome: 'unknown',
      };
      await first.finishAttempt(receipt);
      await second.finishAttempt(receipt);
      expect(await second.attempts(start.callId)).toEqual([receipt]);
      const [before] =
        await firstDb`select receipt,closed_at,recovery_evidence_ref from allrice_model_gateway_attempts where id=${start.id}`;
      const [held] =
        await firstDb`select attempt_id from allrice_model_gateway_slots where attempt_id=${start.id}`;
      expect(held?.attempt_id).toBe(start.id);
      expect(
        await first.usage(binding.vm.personId, binding.vm.organizationId),
      ).toMatchObject({
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        usageComplete: false,
        attemptCount: 1,
        receiptCount: 0,
      });
      await expect(
        second.finishAttempt({ ...receipt, outcome: 'closed' }),
      ).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' });
      await expect(
        firstDb`update allrice_model_gateway_attempts set recovery_evidence_ref='' where id=${start.id}`,
      ).rejects.toThrow('immutable');
      expect(
        await second.reconcileOwner(
          start.ownerId,
          'host-proof:exact-stopped-transport',
        ),
      ).toBe(1);
      expect(
        await first.reconcileOwner(
          start.ownerId,
          'host-proof:exact-stopped-transport',
        ),
      ).toBe(0);
      const [after] =
        await firstDb`select receipt,closed_at,recovery_evidence_ref from allrice_model_gateway_attempts where id=${start.id}`;
      expect(after?.receipt).toEqual(before?.receipt);
      expect(after?.closed_at).toEqual(before?.closed_at);
      expect(after?.recovery_evidence_ref).toBe(
        'host-proof:exact-stopped-transport',
      );
      expect(
        await firstDb`select attempt_id from allrice_model_gateway_slots where attempt_id=${start.id}`,
      ).toHaveLength(0);
      await expect(
        firstDb`update allrice_model_gateway_attempts set recovery_evidence_ref='different-proof' where id=${start.id}`,
      ).rejects.toThrow('immutable');
      const finished = await attempt(binding);
      await first.tryStartAttempt(finished);
      await first.finishAttempt(closed(finished));
      await expect(
        firstDb`update allrice_model_gateway_attempts set recovery_evidence_ref='unrelated-proof' where id=${finished.id}`,
      ).rejects.toThrow('immutable');
    });

    it('slot插入失败时intent一同回滚，约束不会容纳第9个slot', async () => {
      const binding = modelBinding();
      const start = await attempt(binding, first, 'fixture-fail-owner');
      await firstDb.unsafe(`create function fail_meter_slot() returns trigger language plpgsql as $$ begin
      if new.owner_id='fixture-fail-owner' then raise exception 'synthetic slot failure'; end if; return new; end $$;
      create trigger fail_meter_slot before insert on allrice_model_gateway_slots for each row execute function fail_meter_slot()`);
      try {
        await expect(first.tryStartAttempt(start)).rejects.toThrow(
          'synthetic slot failure',
        );
      } finally {
        await firstDb.unsafe(
          'drop trigger fail_meter_slot on allrice_model_gateway_slots; drop function fail_meter_slot()',
        );
      }
      expect(await first.attempts(start.callId)).toEqual([]);
      const next = await attempt(binding);
      await first.tryStartAttempt(next);
      await expect(firstDb`insert into allrice_model_gateway_slots(person_id,slot,attempt_id,owner_id)
      values(${binding.vm.personId},9,${start.id},'fixture')`).rejects.toMatchObject(
        { code: '23514' },
      );
      await first.finishAttempt(closed(next));
    });
  },
);
