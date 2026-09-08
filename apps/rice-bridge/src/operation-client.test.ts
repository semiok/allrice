import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RuntimeBridgeReceipt,
  RuntimeOperationSnapshot,
} from '@allrice/contracts';

import {
  createRuntimeBridgeHttpHandler,
  type RuntimeBridgeLedgerPort,
} from '../../web/lib/bridge/operation-http.js';
import { BridgeJournal, bridgeDigest } from './journal.js';
import { fixtureId, journalDispatch } from './journal-fixtures.js';
import { executeLocalCommand } from './executor.js';
import { RuntimeBridgeOperationClient } from './operation-client.js';
import { bridgeRequest, type BridgeRequestInput } from './client.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function serve(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
) {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing server');
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

async function createFixture(
  options: {
    loseStart?: boolean;
    loseResult?: boolean;
    wrongAck?: boolean;
    cancelStart?: boolean;
  } = {},
) {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-p03b-http-')),
  );
  cleanup.push(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'workspace');
  await mkdir(root);
  const dispatch = journalDispatch(root);
  let snapshot = dispatch.snapshot;
  let dispatched = false;
  let started = false;
  let failedResultOnce = false;
  const accepted: RuntimeBridgeReceipt[] = [];
  // This adapter is a deterministic transport fixture, not a substitute for
  // the PostgreSQL ledger integration suite. HTTP and device disk are real.
  const ledger: RuntimeBridgeLedgerPort = {
    async claimNextBridgeOperation() {
      if (dispatched) return null;
      dispatched = true;
      return { ...dispatch, bridgePayload: dispatch.payload };
    },
    async readOperation() {
      return snapshot;
    },
    async startOperation() {
      const mayExecute = !started && !options.cancelStart;
      started = true;
      snapshot = {
        ...snapshot,
        status: options.cancelStart ? 'cancel_requested' : 'running',
        cancelRequestId: options.cancelStart ? fixtureId(99) : null,
      };
      return { snapshot, mayExecute };
    },
    async recordReceipt(input) {
      const duplicate = accepted.some(
        (receipt) => receipt.receiptId === input.receiptId,
      );
      if (!duplicate) accepted.push(input);
      return { snapshot, disposition: duplicate ? 'duplicate' : 'applied' };
    },
  };
  const authenticate = vi.fn(async (token: string) => {
    if (token !== 'fixture-device-token')
      throw Object.assign(new Error('unauthorized'), {
        code: 'device_unauthorized',
      });
    return {
      device: {
        id: fixtureId(11),
        organizationId: fixtureId(1),
        workspaceId: fixtureId(2),
        ownerId: fixtureId(8),
        name: 'Test device',
        platform: 'macos-arm64' as const,
        protocolVersion: 2 as const,
        capabilities: ['local.fs.write' as const],
        status: 'online' as const,
        lastSeenAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        revokedAt: null,
      },
      grants: [
        {
          id: fixtureId(12),
          deviceId: fixtureId(11),
          label: 'fixture',
          rootFingerprint: dispatch.grantRootFingerprint,
          createdAt: new Date().toISOString(),
          revokedAt: null,
        },
      ],
    };
  });
  const handle = createRuntimeBridgeHttpHandler({
    enabled: () => true,
    authenticate,
    ledgerForDevice: async () => ledger,
  });
  const server = await serve(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.from(chunk as Uint8Array));
    const pathname = new URL(request.url ?? '/', 'http://local').pathname;
    const action = pathname.endsWith('/next')
      ? 'next'
      : pathname.endsWith('/start')
        ? 'start'
        : 'receipts';
    const webRequest = new Request(`http://local${pathname}`, {
      method: 'POST',
      headers: {
        authorization: String(request.headers.authorization ?? ''),
        'content-type': 'application/json',
      },
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const result = await handle(webRequest, action, pathname.split('/').at(-2));
    // Destroy AFTER the route accepted its durable semantic result, emulating
    // dropped response. Client must not confuse delivery with execution.
    if (
      (action === 'start' && options.loseStart) ||
      (action === 'receipts' && options.loseResult && !failedResultOnce)
    ) {
      failedResultOnce = true;
      response.destroy();
      return;
    }
    response.statusCode = result.status;
    response.setHeader('content-type', 'application/json');
    response.end(
      action === 'receipts' && options.wrongAck
        ? JSON.stringify({ accepted: true, receiptId: fixtureId(88) })
        : await result.text(),
    );
  });
  const journalInput = {
    directory: join(temporary, 'journal'),
    server,
    deviceId: fixtureId(11),
  };
  const journal = await BridgeJournal.open(journalInput);
  cleanup.push(() => journal.close());
  const config = {
    server,
    deviceId: fixtureId(11),
    deviceName: 'Fixture',
    grants: [
      {
        id: fixtureId(12),
        label: 'fixture',
        rootPath: root,
        rootFingerprint: dispatch.grantRootFingerprint,
      },
    ],
  };
  const execute = vi.fn(executeLocalCommand);
  const client = new RuntimeBridgeOperationClient({
    config,
    token: 'fixture-device-token',
    journal,
    execute,
  });
  return {
    root,
    journal,
    journalInput,
    config,
    execute,
    client,
    dispatch,
    accepted,
    authenticate,
    ledger,
    handle,
  };
}

describe('HTTP device journal adapter', () => {
  it.each(['before_start', 'after_start_ack'])(
    'P13 pause %s persists stopped evidence without executing',
    async (moment) => {
      const test = await createFixture();
      const abort = new AbortController();
      if (moment === 'before_start') abort.abort();
      const client = new RuntimeBridgeOperationClient({
        config: test.config,
        token: 'fixture-device-token',
        journal: test.journal,
        execute: test.execute,
        signal: abort.signal,
        request: async <T>(input: BridgeRequestInput) => {
          const response = await bridgeRequest<T>(input);
          if (input.path.endsWith('/start')) abort.abort();
          return response;
        },
      });
      await client.handle(test.dispatch);
      expect(test.execute).not.toHaveBeenCalled();
      expect((await test.journal.pending())[0]?.signal.type).toBe(
        'operation.stopped',
      );
      const facts = await test.journal.diagnosticCounts();
      expect(facts).toEqual({ pendingReceipts: 1, unknownOperations: 0 });
      expect(await client.pollOnce()).toBe(false);
      await client.handle(test.dispatch);
      expect(test.execute).not.toHaveBeenCalled();
    },
  );
  it('keeps known success when a real legal long path exceeds summary length', async () => {
    const test = await createFixture();
    const parent = Array.from({ length: 6 }, () => 'd'.repeat(90)).join('/');
    await mkdir(join(test.root, parent), { recursive: true });
    test.dispatch.payload = {
      capability: 'local.fs.write',
      arguments: { path: `${parent}/output.txt`, content: 'long path effect' },
    };
    test.dispatch.snapshot.binding.inputDigest = bridgeDigest(
      test.dispatch.payload,
    );
    await test.client.handle(test.dispatch);
    await test.client.flush();
    expect(await readFile(join(test.root, parent, 'output.txt'), 'utf8')).toBe(
      'long path effect',
    );
    expect(test.accepted[0]?.signal).toMatchObject({
      type: 'operation.outcome',
      result: { status: 'succeeded', effects: 'applied' },
    });
    expect(test.accepted[0]?.evidence?.summary.length).toBeLessThanOrEqual(500);
  });
  it('does not start expired dispatches or mismatched folder grants', async () => {
    const expired = await createFixture();
    expired.dispatch.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    await expired.client.handle(expired.dispatch);
    expect(expired.execute).not.toHaveBeenCalled();
    expect((await expired.journal.pending())[0]?.signal).toEqual({
      type: 'operation.uncertain',
      reason: 'lease_lost',
    });
    const revoked = await createFixture();
    revoked.config.grants = [];
    await revoked.client.handle(revoked.dispatch);
    expect(revoked.execute).not.toHaveBeenCalled();
    expect((await revoked.journal.pending())[0]?.signal).toMatchObject({
      type: 'operation.outcome',
      result: { status: 'failed', effects: 'none' },
    });
  });

  it('runs an existing write through real HTTP preflight and persists its result', async () => {
    const test = await createFixture();
    expect(await test.client.pollOnce()).toBe(true);
    expect(await readFile(join(test.root, 'output.txt'), 'utf8')).toBe(
      'one execution',
    );
    expect(test.execute).toHaveBeenCalledTimes(1);
    expect(test.accepted[0]?.signal).toMatchObject({
      type: 'operation.outcome',
      result: { status: 'succeeded', effects: 'applied' },
    });
    expect(await test.journal.pending()).toEqual([]);
    await test.client.handle(test.dispatch);
    expect(test.execute).toHaveBeenCalledTimes(1);
  });

  it('reopens durable result after accepted-but-lost response; retries delivery only', async () => {
    const test = await createFixture({ loseResult: true });
    await expect(test.client.pollOnce()).rejects.toThrow();
    expect(test.execute).toHaveBeenCalledTimes(1);
    const [receipt] = await test.journal.pending();
    expect(receipt?.signal.type).toBe('operation.outcome');
    await test.journal.close();
    const reopened = await BridgeJournal.open(test.journalInput);
    cleanup.push(() => reopened.close());
    const client = new RuntimeBridgeOperationClient({
      config: test.config,
      token: 'fixture-device-token',
      journal: reopened,
      execute: test.execute,
    });
    expect(await client.pollOnce()).toBe(false);
    expect(test.execute).toHaveBeenCalledTimes(1);
    expect(test.accepted).toHaveLength(1);
    expect(await reopened.pending()).toEqual([]);
    expect(await readFile(join(test.root, 'output.txt'), 'utf8')).toBe(
      'one execution',
    );
  });

  it('does not execute or repeat start after its response is lost', async () => {
    const test = await createFixture({ loseStart: true });
    await test.client.pollOnce();
    expect(test.execute).not.toHaveBeenCalled();
    expect(test.accepted[0]?.signal).toEqual({
      type: 'operation.uncertain',
      reason: 'connection_lost',
    });
    await test.client.handle(test.dispatch);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it('does not execute when cancellation races with the start preflight', async () => {
    const test = await createFixture({ cancelStart: true });
    await test.client.pollOnce();
    expect(test.execute).not.toHaveBeenCalled();
    expect(test.accepted[0]?.signal.type).toBe('operation.uncertain');
  });

  it('retains outbox and blocks acquisition when ACK identity is wrong', async () => {
    const test = await createFixture({ wrongAck: true });
    await expect(test.client.pollOnce()).rejects.toThrow(
      'JOURNAL_ACK_MISMATCH',
    );
    expect(await test.journal.pending()).toHaveLength(1);
    await expect(test.client.pollOnce()).rejects.toThrow(
      'JOURNAL_ACK_MISMATCH',
    );
    expect(test.execute).toHaveBeenCalledTimes(1);
  });

  it('records unknown after an executor exception, never false failed/no-effects', async () => {
    const test = await createFixture();
    test.execute.mockRejectedValueOnce(
      new Error('failure after possible write'),
    );
    await test.client.pollOnce();
    expect(test.accepted[0]?.signal).toEqual({
      type: 'operation.uncertain',
      reason: 'receipt_missing',
    });
  });

  it('bounded HTTP reader stops a too-large response', async () => {
    const server = await serve((_request, response) => {
      response.end(JSON.stringify({ output: 'x'.repeat(10000) }));
    });
    await expect(
      bridgeRequest({ server, path: '/', maximumResponseBytes: 100 }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('default-off handler does not authenticate or touch the ledger', async () => {
    const authenticate = vi.fn();
    const ledgerForDevice = vi.fn();
    const handle = createRuntimeBridgeHttpHandler({
      enabled: () => false,
      authenticate,
      ledgerForDevice,
    });
    expect(
      (
        await handle(
          new Request('http://local/next', { method: 'POST' }),
          'next',
        )
      ).status,
    ).toBe(404);
    expect(authenticate).not.toHaveBeenCalled();
    expect(ledgerForDevice).not.toHaveBeenCalled();
  });

  it('rejects missing credentials, wrong device, malformed and oversized receipt', async () => {
    const test = await createFixture();
    const request = (body: unknown, token = 'fixture-device-token') =>
      new Request('http://local/receipts', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    expect(
      (await test.handle(request({}, ''), 'start', fixtureId(6))).status,
    ).toBe(401);
    expect(
      (await test.handle(request({}), 'receipts', fixtureId(6))).status,
    ).toBe(400);
    expect(
      (
        await test.handle(
          request({ output: 'x'.repeat(550_000) }),
          'receipts',
          fixtureId(6),
        )
      ).status,
    ).toBe(413);
    test.ledger.readOperation = async () =>
      ({
        ...test.dispatch.snapshot,
        binding: {
          ...test.dispatch.snapshot.binding,
          execution: {
            ...test.dispatch.snapshot.binding.execution,
            deviceId: fixtureId(77),
          },
        },
      }) as RuntimeOperationSnapshot;
    expect((await test.handle(request({}), 'start', fixtureId(6))).status).toBe(
      404,
    );
  });
});
