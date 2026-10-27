import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { inspectNativeContextCompatibility } from './conversation/native-context-compatibility.ts';
import {
  NATIVE_JOURNAL_CONTRACT_KEY,
  readNativeJournalContractHighWater,
  recordNativeJournalContract,
} from './native-journal-contract-store.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const generation = 'dsh-0.2.1-rc.2-687f282';

suite('DSH journal contract high-water and context compatibility', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  const row = async () =>
    (
      await fixture.db<{ value: unknown }[]>`
        select value from allrice_runtime_metadata where key=${NATIVE_JOURNAL_CONTRACT_KEY}`
    )[0]?.value;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    fixture = await createAssistantFixtureDatabase({
      throughMigration: '0217_brand_content_feedback.sql',
    });
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
    vi.unstubAllEnvs();
  });

  it('treats a missing row as contract 1, then only raises the high-water', async () => {
    expect(await readNativeJournalContractHighWater(fixture.db)).toEqual({
      highWater: 1,
      recorded: false,
    });
    await recordNativeJournalContract({ current: 1, readsFrom: 1 }, fixture.db);
    expect(await row()).toEqual({ highWater: 1 });
    await recordNativeJournalContract({ current: 2, readsFrom: 1 }, fixture.db);
    expect(await row()).toEqual({ highWater: 2 });
    // An older build cannot read contract-2 journals: refused, row unchanged.
    await expect(
      recordNativeJournalContract({ current: 1, readsFrom: 1 }, fixture.db),
    ).rejects.toThrow('DSH_NATIVE_JOURNAL_CONTRACT_AHEAD');
    // A build that no longer reads the journals already written is refused
    // before it can raise the high-water.
    await expect(
      recordNativeJournalContract({ current: 3, readsFrom: 3 }, fixture.db),
    ).rejects.toThrow('DSH_NATIVE_JOURNAL_CONTRACT_BEHIND');
    expect(await row()).toEqual({ highWater: 2 });
    // Concurrent starts serialize; whichever order, the high-water never drops.
    await Promise.allSettled([
      recordNativeJournalContract({ current: 3, readsFrom: 1 }, fixture.db),
      recordNativeJournalContract({ current: 2, readsFrom: 1 }, fixture.db),
    ]);
    expect(await row()).toEqual({ highWater: 3 });
  });

  it('keeps the baseline written by the migration (same row schema)', async () => {
    await fixture.db`update allrice_runtime_metadata
      set value='{"highWater":3,"since":"0218"}'::jsonb where key=${NATIVE_JOURNAL_CONTRACT_KEY}`;
    expect(
      await recordNativeJournalContract(
        { current: 3, readsFrom: 1 },
        fixture.db,
      ),
    ).toEqual({ highWater: 3, since: '0218' });
    expect(await readNativeJournalContractHighWater(fixture.db)).toEqual({
      highWater: 3,
      recorded: true,
    });
  });

  it('counts chats the installed generation cannot continue, except archived ones', async () => {
    const before = await inspectNativeContextCompatibility(
      { generation, storageRoots: ['/'] },
      fixture.db,
    );
    // The fixture chat has no business origin, so no release can execute it.
    const { task } = await assistantFixture(fixture.db);
    const sessionId = task.chatSessionId;
    const after = await inspectNativeContextCompatibility(
      { generation, storageRoots: ['/'] },
      fixture.db,
    );
    expect(after.incompatibleChats).toBe(before.incompatibleChats + 1);
    await fixture.db`update allrice_chat_sessions set archived_at=now() where id=${sessionId}`;
    expect(
      await inspectNativeContextCompatibility(
        { generation, storageRoots: ['/'] },
        fixture.db,
      ),
    ).toEqual(before);
  });
});
