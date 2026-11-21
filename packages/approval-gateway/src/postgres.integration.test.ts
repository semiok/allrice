import { afterAll, beforeAll, expect, it, describe } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm, open, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresApprovalStore } from './postgres-store.js';
import { createApprovalGateway } from './gateway.js';
import { fixture } from './testing.fixture.js';
import type { ApprovalRef, FrozenPayload } from './contract.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const schema = 'approval_gateway_test_' + randomUUID().replaceAll('-', '');
const signal = () => new AbortController().signal;
let admin: ReturnType<typeof postgres>,
  db: ReturnType<typeof postgres>,
  url: string;
suite('durable outbound approval business ledger (isolated PostgreSQL)', () => {
  beforeAll(async () => {
    if (!process.env.ALLRICE_TEST_DATABASE_URL)
      throw Error('ALLRICE_TEST_DATABASE_URL required');
    admin = postgres(process.env.ALLRICE_TEST_DATABASE_URL, {
      max: 1,
      onnotice: () => {},
    });
    await admin.unsafe(`create schema ${schema}`);
    const parsed = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
    parsed.searchParams.set('options', `-csearch_path=${schema},public`);
    url = parsed.toString();
    db = postgres(url, { max: 3, onnotice: () => {} });
    await db.unsafe(
      await readFile(
        new URL('../migrations/0001_outbound_approvals.sql', import.meta.url),
        'utf8',
      ),
    );
  });
  afterAll(async () => {
    await db?.end();
    if (admin) {
      if (!/^approval_gateway_test_[a-f0-9]{32}$/.test(schema))
        throw Error('invalid test schema');
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
  });
  it('persists exact bytes, serializes duplicate stage/dispatch across stores, and refuses changed content', async () => {
    const f = fixture(createPostgresApprovalStore(db));
    const views = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.gateway.stage(f.binding, f.input, signal()),
      ),
    );
    const ref = views[0]!.ref;
    expect(views.every((v) => v.ref.requestId === ref.requestId)).toBe(true);
    const alternate = createApprovalGateway({
      ...f.options,
      store: createPostgresApprovalStore(db),
    });
    await f.gateway.decide(
      f.context,
      { ...ref, decision: 'approved' },
      signal(),
    );
    await Promise.all([
      f.gateway.execute(f.binding, ref, signal()),
      alternate.execute(f.binding, ref, signal()),
    ]);
    expect(f.dispatches).toBe(1);
    expect((await alternate.view(f.context, ref, signal())).effect).toBe(
      'received',
    );
    await expect(
      alternate.stage(f.binding, { ...f.input, body: 'new payload' }, signal()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      alternate.revoke(f.context, ref, signal()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('rejects receipt mismatch and serializes revoke against dispatch claim', async () => {
    const store = createPostgresApprovalStore(db),
      f = fixture(store);
    const { ref } = await f.gateway.stage(f.binding, f.input, signal());
    await expect(store.claim(ref)).rejects.toMatchObject({
      code: 'NOT_CONFIRMED',
    });
    await f.gateway.decide(
      f.context,
      { ...ref, decision: 'approved' },
      signal(),
    );
    const results = await Promise.allSettled([
      store.revoke(ref),
      store.claim(ref),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const saved = (await store.get(ref.requestId))!;
    expect(saved.revoked && !!saved.intentAt).toBe(false);
    await expect(
      store.receive(ref, { id: 'wrong', digest: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('retains the first controlled failure across PostgreSQL store reconstruction', async () => {
    const store = createPostgresApprovalStore(db),
      f = fixture(store);
    const { ref } = await f.gateway.stage(f.binding, f.input, signal());
    await store.decide(ref, f.context.actor.id, 'approved');
    await store.claim(ref);
    const first = await store.noteFailure(ref, {
      kind: 'RECEIPT_INTEGRITY',
      code: 'INTEGRITY',
    });
    const restarted = createPostgresApprovalStore(db);
    await restarted.noteFailure(ref, { kind: 'CANCELLED', code: null });
    const persisted = (await restarted.get(ref.requestId))!;
    expect(persisted.failure).toEqual(first.failure);
    expect(persisted.failure?.at).toBeTruthy();
    expect(persisted.intentAt).toBeTruthy();
    expect((await restarted.claim(ref)).claimed).toBe(false);
    await restarted.receive(ref, { id: 'reconciled', digest: ref.digest });
    expect((await restarted.get(ref.requestId))!.failure).toEqual(
      first.failure,
    );
  });
  it('does not resend after a real gateway process dies following durable receiver commit before ACK', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'approval-receiver-'));
    const f = fixture(createPostgresApprovalStore(db));
    const { ref } = await f.gateway.stage(f.binding, f.input, signal());
    await f.gateway.decide(
      f.context,
      { ...ref, decision: 'approved' },
      signal(),
    );
    let child: ReturnType<typeof spawn> | undefined,
      posts = 0;
    let receiverFailure: unknown;
    const server = createServer((req, res) => {
      void (async () => {
        if (req.method === 'POST' && req.url === '/accept') {
          const chunks: Buffer[] = [];
          for await (const part of req) chunks.push(Buffer.from(part));
          const received = JSON.parse(Buffer.concat(chunks).toString()) as {
            ref: ApprovalRef;
            payload: FrozenPayload;
          };
          expect(received.ref).toEqual(ref);
          posts++;
          const temporary = join(directory, 'receipt.tmp'),
            durable = join(directory, 'receipt.json');
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(JSON.stringify(received));
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, durable);
          const parent = await open(directory, 'r');
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
          child!.kill('SIGKILL'); // Actual caller process loss, not a thrown in-process exception.
          res.destroy();
          return;
        }
        if (req.method === 'GET' && req.url === '/receipt') {
          const persisted = JSON.parse(
            await readFile(join(directory, 'receipt.json'), 'utf8'),
          ) as { ref: ApprovalRef };
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              id: 'durable-receipt',
              digest: persisted.ref.digest,
            }),
          );
          return;
        }
        res.writeHead(404).end();
      })().catch((error) => {
        receiverFailure = error;
        res.destroy();
      });
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('address');
      const origin = `http://127.0.0.1:${address.port}`;
      child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('./crash.fixture.ts', import.meta.url)),
        ],
        {
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          stdio: 'ignore',
          env: {
            PATH: process.env.PATH,
            APPROVAL_TEST_DATABASE_URL: url,
            APPROVAL_TEST_REQUEST_ID: ref.requestId,
            APPROVAL_TEST_RECEIVER: origin,
          },
        },
      );
      const termination = await new Promise<NodeJS.Signals | null>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            child!.kill('SIGKILL');
            reject(Error('child did not reach commit boundary'));
          }, 10000);
          child!.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child!.once('exit', (_code, signal) => {
            clearTimeout(timer);
            resolve(signal);
          });
        },
      );
      expect(receiverFailure).toBeUndefined();
      expect(termination).toBe('SIGKILL');
      expect((await f.store.get(ref.requestId))!.intentAt).not.toBeNull();
      expect((await f.store.get(ref.requestId))!.receipt).toBeNull();
      const persisted = JSON.parse(
        await readFile(join(directory, 'receipt.json'), 'utf8'),
      ) as { payload: FrozenPayload };
      expect(
        Buffer.from(
          persisted.payload.attachments[0]!.base64,
          'base64',
        ).toString(),
      ).toBe('frozen source');
      f.options.destinations.inbox.lookup = async () =>
        (await fetch(origin + '/receipt')).json();
      f.options.destinations.inbox.dispatch = async () => {
        throw Error('must never re-dispatch after crash');
      };
      const restarted = createApprovalGateway(f.options);
      expect((await restarted.execute(f.binding, ref, signal())).effect).toBe(
        'unknown',
      );
      expect((await restarted.reconcile(f.context, ref, signal())).effect).toBe(
        'received',
      );
      expect(posts).toBe(1);
      expect(
        (await restarted.execute(f.binding, ref, signal())).receipt?.id,
      ).toBe('durable-receipt');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) =>
          child!.once('exit', () => resolve()),
        );
        child.kill('SIGKILL');
        await exited;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 20000);
});
