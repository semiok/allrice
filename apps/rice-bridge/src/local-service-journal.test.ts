import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RuntimeLocalCommandSchema,
  localCommandToolchainImageV1,
  type RuntimeLocalServiceInput,
  type RuntimeLocalServiceEvent,
} from '@allrice/contracts';
import { BridgeJournal, bridgeDigest } from './journal.js';
import { fixtureId, journalDispatch } from './journal-fixtures.js';
import { flushLocalServiceEvents } from './local-process-manager.js';
import type { BridgeConfig } from './config.js';
import type { bridgeRequest } from './client.js';

const roots: string[] = [],
  journals: BridgeJournal[] = [];
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(
  options: {
    limits?: { entries: number; bytes: number };
    maxBytes?: number;
  } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-p09c-journal-')),
  );
  roots.push(root);
  const config = {
    directory: join(root, 'journal'),
    server: 'https://tenant.example',
    deviceId: fixtureId(11),
    limits: options.limits,
  };
  const dispatch = journalDispatch(root);
  dispatch.payload = RuntimeLocalCommandSchema.parse({
    capability: 'local.process.execute',
    arguments: {
      executable: '/usr/local/bin/node',
      args: ['service.mjs'],
      path: '.',
      files: [{ path: 'service.mjs', sha256: bridgeDigest('synthetic') }],
      imageDigest: localCommandToolchainImageV1,
      isolation: 'local-vm-container-v1',
      network: 'none',
      limits: {
        timeoutMs: 10000,
        outputBytes: 8192,
        memoryMiB: 128,
        cpuMillis: 500,
        pids: 32,
      },
      background: {
        durationMs: 15000,
        readiness: { kind: 'tcp', port: 3100, path: '/', timeoutMs: 5000 },
        stdin: {
          mode: 'requests-v1',
          maxRequests: 16,
          maxBytes: options.maxBytes ?? 100,
          requestTimeoutMs: 5000,
        },
      },
    },
  });
  dispatch.snapshot.binding.action = 'local.process.execute';
  dispatch.snapshot.binding.inputDigest = bridgeDigest(dispatch.payload);
  const journal = await BridgeJournal.open(config);
  journals.push(journal);
  await journal.receive(dispatch);
  await journal.begin(fixtureId(6));
  const services = journal.serviceJournal();
  const starting: RuntimeLocalServiceEvent = {
    type: 'starting',
    processId: fixtureId(6),
    attemptId: fixtureId(7),
    sequence: 0,
    containerId: 'a'.repeat(64),
    hardDeadlineAt: new Date(Date.now() + 15000).toISOString(),
  };
  await services.event(fixtureId(6), starting);
  const request: RuntimeLocalServiceEvent = {
    type: 'input_request',
    processId: fixtureId(6),
    attemptId: fixtureId(7),
    sequence: 1,
    request: {
      requestId: randomUUID(),
      sequence: 0,
      prompt: '输入合成数据',
      maxBytes: options.maxBytes ?? 100,
      expiresAt: new Date(Date.now() + 5000).toISOString(),
    },
  };
  await services.event(fixtureId(6), request);
  const value = { kind: 'text' as const, text: 'synthetic\n' };
  const input: RuntimeLocalServiceInput = {
    inputId: randomUUID(),
    requestId: request.request.requestId,
    sequence: 0,
    expiresAt: request.request.expiresAt,
    ...value,
    digest: bridgeDigest(value),
  };
  return { config, journal, services, input, starting, request, dispatch };
}
describe('P09-c durable local service evidence', () => {
  it('reserves service evidence separately from the terminal receipt without increasing ordinary command reservations', async () => {
    await expect(
      fixture({ limits: { entries: 10, bytes: 800_000 } }),
    ).rejects.toThrow('JOURNAL_CAPACITY_REACHED');
    const f = await fixture({
      limits: { entries: 10, bytes: 2_000_000 },
      maxBytes: 4096,
    });
    const ordinary = await BridgeJournal.open({
      ...f.config,
      directory: `${f.config.directory}-ordinary`,
      limits: { entries: 10, bytes: 800_000 },
    });
    journals.push(ordinary);
    await expect(
      ordinary.receive(journalDispatch(f.config.directory)),
    ).resolves.toBe('new');
    const second = journalDispatch(f.config.directory);
    second.snapshot.binding.attempt.operationId = fixtureId(66);
    await expect(f.journal.receive(second)).rejects.toThrow(
      'JOURNAL_CAPACITY_REACHED',
    );
    // The maximum input count with six-byte JSON escapes must still leave room
    // for a near-limit known result after intake has refused further work.
    for (let i = 0; i < 16; i++) {
      const request =
        i === 0
          ? f.request.request
          : {
              ...f.request.request,
              requestId: randomUUID(),
              sequence: i,
              prompt: '\u0001'.repeat(500),
            };
      if (i > 0)
        await f.services.event(fixtureId(6), {
          type: 'input_request',
          processId: fixtureId(6),
          attemptId: fixtureId(7),
          sequence: 1 + i * 2,
          request,
        });
      const value = { kind: 'text' as const, text: '\u0001'.repeat(4096) };
      const input = {
        ...value,
        inputId: randomUUID(),
        requestId: request.requestId,
        sequence: i,
        expiresAt: request.expiresAt,
        digest: bridgeDigest(value),
      };
      expect(await f.services.prepare(fixtureId(6), input)).toBe('new');
      await f.services.event(fixtureId(6), {
        type: 'input_delivered',
        processId: fixtureId(6),
        attemptId: fixtureId(7),
        sequence: 2 + i * 2,
        inputId: input.inputId,
        requestId: input.requestId,
        inputSequence: i,
        digest: input.digest,
        kind: input.kind,
      });
    }
    await f.journal.outcome(fixtureId(6), {
      status: 'succeeded',
      effects: 'applied',
      summary: 'synthetic capacity proof',
      output: 'x'.repeat(450_000),
    });
    expect(await f.journal.pending()).toHaveLength(1);
    expect(
      (await stat(join(f.config.directory, 'journal.sqlite'))).size,
    ).toBeLessThan(2_000_000);
    await f.journal.close();
    const reopened = await BridgeJournal.open(f.config);
    journals.push(reopened);
    expect((await reopened.pending())[0]?.signal.type).toBe(
      'operation.outcome',
    );
  });
  it('persists unacknowledged events and prepared input over SQLite close/reopen; never retries unknown pipe effects', async () => {
    const f = await fixture();
    expect(await f.services.prepare(fixtureId(6), f.input)).toBe('new');
    await f.journal.close();
    const reopened = await BridgeJournal.open(f.config);
    journals.push(reopened);
    expect(
      (await reopened.serviceJournal().pending(fixtureId(6))).map(
        (e) => e.type,
      ),
    ).toEqual(['starting', 'input_request']);
    await expect(
      reopened.serviceJournal().prepare(fixtureId(6), f.input),
    ).rejects.toThrow('SERVICE_INPUT_EFFECT_UNKNOWN');
    expect((await reopened.pending())[0]?.signal.type).toBe(
      'operation.uncertain',
    );
    expect(await reopened.serviceJournal().pending(fixtureId(6))).toHaveLength(
      2,
    );
  });
  it('ACK loss retries evidence only after a durable pipe delivery', async () => {
    const f = await fixture();
    await f.services.prepare(fixtureId(6), f.input);
    const delivered: RuntimeLocalServiceEvent = {
      type: 'input_delivered',
      processId: fixtureId(6),
      attemptId: fixtureId(7),
      sequence: 2,
      inputId: f.input.inputId,
      requestId: f.input.requestId,
      inputSequence: 0,
      digest: f.input.digest,
      kind: 'text',
    };
    await f.services.event(fixtureId(6), delivered);
    await f.journal.close();
    const reopened = await BridgeJournal.open(f.config);
    journals.push(reopened);
    const services = reopened.serviceJournal();
    expect(await services.prepare(fixtureId(6), f.input)).toBe('delivered');
    await services.event(fixtureId(6), delivered);
    expect(await services.pending(fixtureId(6))).toHaveLength(3);
    await services.acknowledge(fixtureId(6), 2);
    expect(await services.pending(fixtureId(6))).toEqual([]);
    await expect(reopened.begin(fixtureId(6))).rejects.toThrow(
      'JOURNAL_EXECUTION_ALREADY_CLAIMED',
    );
  });
  it('flushes lifecycle evidence independently after owner restart and a lost delivery ACK', async () => {
    const f = await fixture();
    await f.services.prepare(fixtureId(6), f.input);
    await f.services.event(fixtureId(6), {
      type: 'input_delivered',
      processId: fixtureId(6),
      attemptId: fixtureId(7),
      sequence: 2,
      inputId: f.input.inputId,
      requestId: f.input.requestId,
      inputSequence: 0,
      digest: f.input.digest,
      kind: 'text',
    });
    await f.journal.close();
    const reopened = await BridgeJournal.open(f.config);
    journals.push(reopened);
    const config = {
      server: f.config.server,
      deviceId: f.config.deviceId,
    } as BridgeConfig;
    await expect(
      flushLocalServiceEvents({
        journal: reopened,
        config,
        token: 'synthetic',
        request: async () => {
          throw Error('synthetic lost ACK');
        },
      }),
    ).rejects.toThrow('synthetic lost ACK');
    expect(await reopened.serviceJournal().pending(fixtureId(6))).toHaveLength(
      3,
    );
    let calls = 0;
    await flushLocalServiceEvents({
      journal: reopened,
      config,
      token: 'synthetic',
      request: async <T>(request: Parameters<typeof bridgeRequest>[0]) => {
        calls++;
        expect(request.body).toMatchObject({
          deliveryOnly: true,
          attempt: f.dispatch.snapshot.binding.attempt,
          leaseToken: f.dispatch.leaseToken,
        });
        return {
          snapshot: { ...f.dispatch.snapshot, status: 'unknown' },
          leaseExpiresAt: f.dispatch.leaseExpiresAt,
          hardDeadlineAt: new Date(Date.now() + 5000).toISOString(),
          acceptedSequence: 2,
          inputs: [],
          stopRequested: true,
        } as T;
      },
    });
    expect(calls).toBe(1);
    expect(await reopened.serviceJournal().pending(fixtureId(6))).toEqual([]);
    expect(await reopened.serviceJournal().prepare(fixtureId(6), f.input)).toBe(
      'delivered',
    );
  });
  it('rejects event conflicts and a receipt ACK beyond locally persisted evidence', async () => {
    const f = await fixture();
    await f.services.event(fixtureId(6), f.starting);
    await expect(f.services.acknowledge(fixtureId(6), 3)).rejects.toThrow(
      'SERVICE_ACK_INVALID',
    );
    await expect(f.journal.pending()).resolves.toEqual([]);
  });
  it.each(['expiry', 'sequence', 'request'] as const)(
    'refuses %s mismatch before any stdin write',
    async (which) => {
      const f = await fixture();
      const value = { ...f.input };
      if (which === 'expiry') value.expiresAt = new Date(0).toISOString();
      else if (which === 'sequence') value.sequence = 1;
      else value.requestId = randomUUID();
      await expect(f.services.prepare(fixtureId(6), value)).rejects.toThrow(
        'SERVICE_INPUT_REQUEST_MISMATCH',
      );
      await expect(
        f.journal.uncertain(fixtureId(6), 'receipt_missing'),
      ).resolves.toBeDefined();
    },
  );
});
