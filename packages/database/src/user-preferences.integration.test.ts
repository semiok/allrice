import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultUserPreferences } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import {
  getUserPreferences,
  updateUserPreferences,
} from './user-preferences.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('account output preferences', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    if (fixture) await fixture.close();
  });
  it('defaults on, persists for a normal member across workspaces, and isolates other users', async () => {
    const f = await createExperienceFixture(fixture.db);
    expect(await getUserPreferences(f.owner)).toEqual(defaultUserPreferences);
    expect((await getUserPreferences(f.owner)).streamingOutput).toBe(true);
    const saved = await updateUserPreferences(f.owner, {
      streamingOutput: true,
    });
    expect(saved.streamingOutput).toBe(true);
    expect(saved.updatedAt).not.toBeNull();
    expect(await getUserPreferences({ ...f.owner, workspaceId: null })).toEqual(
      saved,
    );
    expect(await getUserPreferences(f.neighbor)).toEqual(
      defaultUserPreferences,
    );
    await expect(
      updateUserPreferences(f.owner, {
        streamingOutput: false,
        userId: f.neighbor.actor.id,
      }),
    ).rejects.toThrow();
    expect(await getUserPreferences(f.owner)).toEqual(saved);
    await updateUserPreferences(f.owner, { streamingOutput: false });
    expect((await getUserPreferences(f.owner)).streamingOutput).toBe(false);
  });
  it('updates one display preference without resetting other fields, including concurrent saves', async () => {
    const f = await createExperienceFixture(fixture.db);
    await updateUserPreferences(f.owner, {
      streamingOutput: true,
      collapseTiming: 'next-input',
    });
    await Promise.all([
      updateUserPreferences(f.owner, { fontSize: 18 }),
      updateUserPreferences(f.owner, { transcriptView: 'compact' }),
      updateUserPreferences(f.owner, { appearance: 'dark' }),
    ]);
    expect(await getUserPreferences(f.owner)).toMatchObject({
      streamingOutput: true,
      fontSize: 18,
      transcriptView: 'compact',
      collapseTiming: 'next-input',
      appearance: 'dark',
    });
    // Appearance and an older field saved together do not overwrite each other.
    await Promise.all([
      updateUserPreferences(f.owner, { appearance: 'system' }),
      updateUserPreferences(f.owner, { collapseTiming: 'completion' }),
      updateUserPreferences(f.owner, { streamingOutput: false }),
    ]);
    expect(await getUserPreferences(f.owner)).toMatchObject({
      streamingOutput: false,
      fontSize: 18,
      transcriptView: 'compact',
      collapseTiming: 'completion',
      appearance: 'system',
    });
    // An older client's streaming-only PATCH must keep newer display choices.
    await updateUserPreferences(f.owner, { streamingOutput: true });
    expect(
      await getUserPreferences({ ...f.owner, workspaceId: null }),
    ).toMatchObject({
      streamingOutput: true,
      fontSize: 18,
      transcriptView: 'compact',
      collapseTiming: 'completion',
      appearance: 'system',
    });
    expect(await getUserPreferences(f.neighbor)).toEqual(
      defaultUserPreferences,
    );
  });
  it('rejects invalid display values without changing the saved account', async () => {
    const f = await createExperienceFixture(fixture.db);
    const saved = await updateUserPreferences(f.owner, { fontSize: 22 });
    for (const update of [
      { fontSize: 9 },
      { fontSize: 23 },
      { fontSize: 14.5 },
      { transcriptView: 'all' },
      { collapseTiming: 'every-message' },
      { fontSize: 16, userId: f.neighbor.actor.id },
    ])
      await expect(updateUserPreferences(f.owner, update)).rejects.toThrow();
    expect(await getUserPreferences(f.owner)).toEqual(saved);
  });
  it('retains the streaming default when first saving a display preference or inserting a new account row', async () => {
    const f = await createExperienceFixture(fixture.db);
    const saved = await updateUserPreferences(f.owner, { fontSize: 16 });
    expect(saved.streamingOutput).toBe(true);
    const [inserted] = await fixture.db`
      insert into allrice_user_preferences(user_id)
      values (${f.neighbor.actor.id}) returning streaming_output
    `;
    expect(inserted?.streaming_output).toBe(true);
    expect((await getUserPreferences(f.neighbor)).streamingOutput).toBe(true);
  });
  it('defaults appearance to light and saves each choice without touching other preferences', async () => {
    const f = await createExperienceFixture(fixture.db);
    expect((await getUserPreferences(f.owner)).appearance).toBe('light');
    await updateUserPreferences(f.owner, {
      fontSize: 18,
      collapseTiming: 'next-input',
    });
    expect((await getUserPreferences(f.owner)).appearance).toBe('light');
    for (const appearance of ['dark', 'system', 'light', 'dark'] as const) {
      const saved = await updateUserPreferences(f.owner, { appearance });
      expect(saved).toMatchObject({
        appearance,
        fontSize: 18,
        collapseTiming: 'next-input',
      });
      expect(
        await getUserPreferences({ ...f.owner, workspaceId: null }),
      ).toEqual(saved);
    }
    // Saving another field (including an older client's PATCH) keeps the choice.
    await updateUserPreferences(f.owner, { streamingOutput: false });
    await updateUserPreferences(f.owner, { transcriptView: 'compact' });
    expect(await getUserPreferences(f.owner)).toMatchObject({
      appearance: 'dark',
      streamingOutput: false,
      fontSize: 18,
      transcriptView: 'compact',
      collapseTiming: 'next-input',
    });
    expect((await getUserPreferences(f.neighbor)).appearance).toBe('light');
    const firstSave = await updateUserPreferences(f.neighbor, {
      appearance: 'system',
    });
    expect(firstSave).toEqual({
      ...defaultUserPreferences,
      appearance: 'system',
      updatedAt: firstSave.updatedAt,
    });
  });
  it('rejects invalid appearance values in the service and the table', async () => {
    const f = await createExperienceFixture(fixture.db);
    const saved = await updateUserPreferences(f.owner, { appearance: 'dark' });
    for (const update of [
      { appearance: 'auto' },
      { appearance: 'Dark' },
      { appearance: '' },
      { appearance: null },
      { appearance: 1 },
    ])
      await expect(updateUserPreferences(f.owner, update)).rejects.toThrow();
    await expect(
      fixture.db`update allrice_user_preferences set appearance='auto' where user_id=${f.owner.actor.id}`,
    ).rejects.toThrow(/check constraint/);
    await expect(
      fixture.db`update allrice_user_preferences set appearance=null where user_id=${f.owner.actor.id}`,
    ).rejects.toThrow(/null value/);
    expect(await getUserPreferences(f.owner)).toEqual(saved);
    const [inserted] = await fixture.db`
      insert into allrice_user_preferences(user_id)
      values (${f.neighbor.actor.id}) returning appearance
    `;
    expect(inserted?.appearance).toBe('light');
  });
  // MET-210 (user 10-27): DSH's own question wait and subagent settings.
  it('saves each agent preference group alone and keeps the other choices', async () => {
    const f = await createExperienceFixture(fixture.db);
    await updateUserPreferences(f.owner, { appearance: 'dark', fontSize: 18 });
    const timed = await updateUserPreferences(f.owner, {
      questionWait: { mode: 'timed', seconds: 300 },
    });
    expect(timed).toMatchObject({
      appearance: 'dark',
      fontSize: 18,
      questionWait: { mode: 'timed', seconds: 300 },
      subagents: { maxDepth: 1, maxActive: 8 },
    });
    await updateUserPreferences(f.owner, {
      subagents: { maxDepth: 0, maxActive: 12 },
    });
    const forever = await updateUserPreferences(f.owner, {
      questionWait: { mode: 'forever' },
    });
    expect(forever).toMatchObject({
      questionWait: { mode: 'forever' },
      subagents: { maxDepth: 0, maxActive: 12 },
    });
    expect(await getUserPreferences(f.owner)).toEqual(forever);
    for (const update of [
      { questionWait: { mode: 'timed', seconds: 0 } },
      { questionWait: { mode: 'timed' } },
      { subagents: { maxDepth: -1, maxActive: 1 } },
      { subagents: { maxDepth: 1, maxActive: 0 } },
    ])
      await expect(updateUserPreferences(f.owner, update)).rejects.toThrow();
    await expect(
      fixture.db`update allrice_user_preferences set question_wait_mode='timed' where user_id=${f.owner.actor.id}`,
    ).rejects.toThrow(/check constraint/);
    expect(await getUserPreferences(f.owner)).toEqual(forever);
  });
  // Runs last: it rebuilds the pre-0222 column set inside this suite's schema.
  it('migration 0222 sets existing rows to light and keeps their other choices', async () => {
    const f = await createExperienceFixture(fixture.db);
    await updateUserPreferences(f.owner, {
      streamingOutput: false,
      fontSize: 18,
      transcriptView: 'compact',
      collapseTiming: 'next-input',
      appearance: 'dark',
    });
    const [before] = await fixture.db<{ updated_at: Date }[]>`
      select updated_at from allrice_user_preferences where user_id=${f.owner.actor.id}
    `;
    // Only this suite's own schema: never a table in public, however the
    // fixture builds its tables later.
    const [scope] = await fixture.db<
      { schema: string }[]
    >`select current_schema() as schema`;
    const schema = scope!.schema;
    expect(schema).toMatch(/^p25_[a-f0-9]{32}$/);
    await fixture.db.unsafe(
      `alter table "${schema}".allrice_user_preferences drop column appearance`,
    );
    const migration = await readFile(
      new URL('../migrations/0222_appearance_preference.sql', import.meta.url),
      'utf8',
    );
    const migrate = () =>
      fixture.db.begin(async (tx) => {
        await tx.unsafe(`set local search_path to "${schema}"`);
        await tx.unsafe(migration);
      });
    await migrate();
    expect(await getUserPreferences(f.owner)).toEqual({
      streamingOutput: false,
      fontSize: 18,
      transcriptView: 'compact',
      collapseTiming: 'next-input',
      appearance: 'light',
      // MET-210 0223 defaults, untouched by re-running 0222.
      questionWait: { mode: 'default' },
      subagents: { maxDepth: 1, maxActive: 8 },
      updatedAt: before!.updated_at.toISOString(),
    });
    // The runner records each file once; a manual second run fails unchanged.
    await expect(migrate()).rejects.toThrow(/already exists/);
    expect((await getUserPreferences(f.owner)).appearance).toBe('light');
  });
});
