import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  RuntimeBridgeDispatchSchema,
  localCommandToolchainImageV1,
} from '@allrice/contracts';
import { BridgeJournal, bridgeDigest } from './journal.js';
import { fixtureId, journalDispatch } from './journal-fixtures.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-p12-output-')),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const input = {
    directory: join(root, 'journal'),
    server: 'https://tenant.example',
    deviceId: fixtureId(11),
  };
  const dispatch = journalDispatch(root);
  const payload = {
    capability: 'local.process.execute',
    arguments: {
      executable: '/usr/local/bin/node',
      args: ['main.cjs'],
      path: '.',
      files: [{ path: 'main.cjs', sha256: `sha256:${'a'.repeat(64)}` }],
      isolation: 'local-vm-container-v1',
      imageDigest: localCommandToolchainImageV1,
      network: 'none',
      limits: {
        timeoutMs: 1000,
        outputBytes: 65536,
        memoryMiB: 128,
        cpuMillis: 500,
        pids: 32,
      },
    },
  };
  const parsed = RuntimeBridgeDispatchSchema.parse({
    ...dispatch,
    payload,
    snapshot: {
      ...dispatch.snapshot,
      binding: {
        ...dispatch.snapshot.binding,
        action: payload.capability,
        inputDigest: bridgeDigest(payload),
      },
    },
  });
  const open = async () => {
    const journal = await BridgeJournal.open(input);
    cleanup.push(() => journal.close());
    return journal;
  };
  const journal = await open();
  await journal.receive(parsed);
  await journal.begin(fixtureId(6));
  return { journal, open, id: fixtureId(6), parsed };
}

it('retains ordered output through real SQLite close/reopen and lost acknowledgments', async () => {
  const { journal, open, id, parsed } = await fixture();
  const first = await journal.recordOutput(id, {
    sequence: 0,
    stream: 'stdout',
    text: 'first\n',
  });
  const second = await journal.recordOutput(id, {
    sequence: 1,
    stream: 'stderr',
    text: 'second\n',
  });
  expect(first.attempt).toEqual(parsed.snapshot.binding.attempt);
  expect(first.leaseToken).toBe(parsed.leaseToken);
  expect(
    await journal.recordOutput(id, {
      sequence: 0,
      stream: 'stdout',
      text: 'first\n',
    }),
  ).toEqual(first);
  await journal.close();
  const recovered = await open();
  expect(await recovered.pendingOutput()).toEqual([first, second]);
  // Restart makes a started command unknown; retained logs cannot start it again.
  expect((await recovered.pending())[0]?.signal.type).toBe(
    'operation.uncertain',
  );
  await expect(recovered.begin(id)).rejects.toThrow(
    'JOURNAL_EXECUTION_ALREADY_CLAIMED',
  );
  await recovered.acknowledgeOutput(id, 0);
  await recovered.acknowledgeOutput(id, 0);
  await recovered.close();
  const again = await open();
  expect(await again.pendingOutput()).toEqual([second]);
});

it('rejects conflicting duplicate, missing sequence and total UTF-8 byte overflow without erasing evidence', async () => {
  const { journal, id } = await fixture();
  await journal.recordOutput(id, {
    sequence: 0,
    stream: 'stdout',
    text: 'a'.repeat(65530),
  });
  await expect(
    journal.recordOutput(id, {
      sequence: 0,
      stream: 'stderr',
      text: 'different',
    }),
  ).rejects.toThrow('JOURNAL_OUTPUT_CONFLICT');
  await expect(
    journal.recordOutput(id, { sequence: 2, stream: 'stdout', text: 'gap' }),
  ).rejects.toThrow('JOURNAL_OUTPUT_LIMIT');
  await expect(
    journal.recordOutput(id, {
      sequence: 1,
      stream: 'stdout',
      text: '中文多字',
    }),
  ).rejects.toThrow('JOURNAL_OUTPUT_LIMIT');
  await journal.recordOutput(id, {
    sequence: 1,
    stream: 'stdout',
    text: '中文',
  });
  expect(await journal.pendingOutput()).toHaveLength(2);
});

it('preserves output until delivery after the final receipt, with bounded retrieval', async () => {
  const { journal, id } = await fixture();
  for (let sequence = 0; sequence < 40; sequence++)
    await journal.recordOutput(id, {
      sequence,
      stream: 'stdout',
      text: `${sequence}\n`,
    });
  await journal.outcome(id, {
    status: 'succeeded',
    effects: 'none',
    summary: 'test complete',
  });
  expect(await journal.pendingOutput(500)).toHaveLength(32);
  await expect(
    journal.recordOutput(id, { sequence: 40, stream: 'stdout', text: 'late' }),
  ).rejects.toThrow('JOURNAL_OUTPUT_ALREADY_FINAL');
  expect(await journal.pending()).toHaveLength(1);
});
