import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RuntimeBridgeDispatchSchema } from '@allrice/contracts';
import { BridgeJournal, bridgeDigest } from './journal.js';
import { journalDispatch } from './journal-fixtures.js';
import { fixturePayload } from '../test/local-mcp.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture(call = true) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-p17-journal-')),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const base = journalDispatch(root),
    payload = fixturePayload(undefined, call);
  payload.arguments.deviceId = base.snapshot.binding.execution.deviceId!;
  const dispatch = RuntimeBridgeDispatchSchema.parse({
    ...base,
    payload,
    snapshot: {
      ...base.snapshot,
      binding: {
        ...base.snapshot.binding,
        action: payload.capability,
        inputDigest: bridgeDigest(payload),
      },
    },
  });
  const input = {
    directory: join(root, 'private'),
    server: 'https://synthetic.example',
    deviceId: payload.arguments.deviceId,
  };
  const journal = await BridgeJournal.open(input);
  cleanup.push(() => journal.close());
  return { input, journal, dispatch };
}
const intent = { requestId: 'call:one', digest: `sha256:${'d'.repeat(64)}` };

it('persists one call intent before dispatch and rejects any second call before or after restart', async () => {
  const { journal, dispatch, input } = await fixture();
  const id = dispatch.snapshot.binding.attempt.operationId;
  await journal.receive(dispatch);
  await expect(journal.prepareLocalMcpCall(id, intent)).rejects.toThrow(
    'MCP_UNKNOWN',
  );
  await journal.begin(id);
  await journal.prepareLocalMcpCall(id, intent);
  await expect(journal.prepareLocalMcpCall(id, intent)).rejects.toThrow(
    'MCP_UNKNOWN',
  );
  await journal.close();
  const recovered = await BridgeJournal.open(input);
  cleanup.push(() => recovered.close());
  await expect(
    recovered.prepareLocalMcpCall(id, { ...intent, requestId: 'different' }),
  ).rejects.toThrow('MCP_UNKNOWN');
  expect(
    (await recovered.pending()).some(
      (r) => r.signal.type === 'operation.uncertain',
    ),
  ).toBe(true);
  expect(
    (await recovered.unknownLocalMcpOperations()).map(
      (d) => d.snapshot.binding.attempt.operationId,
    ),
  ).toEqual([id]);
});

it('never permits discovery to prepare a tools/call, and validates bounded intent identity', async () => {
  const { journal, dispatch } = await fixture(false),
    id = dispatch.snapshot.binding.attempt.operationId;
  await journal.receive(dispatch);
  await journal.begin(id);
  await expect(journal.prepareLocalMcpCall(id, intent)).rejects.toThrow(
    'MCP_UNKNOWN',
  );
  await expect(
    journal.prepareLocalMcpCall(id, { ...intent, requestId: 'a'.repeat(129) }),
  ).rejects.toThrow('MCP_INVALID_CALL_INTENT');
});

it('rotates the bounded orphan scan instead of permanently starving later unknown attempts', async () => {
  const { journal, dispatch } = await fixture();
  const expected = new Set<string>();
  for (let i = 0; i < 34; i++) {
    const operationId = randomUUID();
    expected.add(operationId);
    const d = RuntimeBridgeDispatchSchema.parse({
      ...dispatch,
      snapshot: {
        ...dispatch.snapshot,
        idempotencyKey: randomUUID(),
        binding: {
          ...dispatch.snapshot.binding,
          attempt: {
            ...dispatch.snapshot.binding.attempt,
            operationId,
            attemptId: randomUUID(),
          },
        },
      },
    });
    await journal.receive(d);
    await journal.begin(operationId);
    await journal.uncertain(operationId, 'receipt_missing');
  }
  const seen = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const batch = await journal.unknownLocalMcpOperations();
    expect(batch.length).toBeLessThanOrEqual(16);
    batch.forEach((d) => seen.add(d.snapshot.binding.attempt.operationId));
  }
  expect(seen).toEqual(expected);
  expect((await journal.unknownLocalMcpOperations()).length).toBe(16);
});
