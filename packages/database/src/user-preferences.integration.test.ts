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
    ]);
    expect(await getUserPreferences(f.owner)).toMatchObject({
      streamingOutput: true,
      fontSize: 18,
      transcriptView: 'compact',
      collapseTiming: 'next-input',
    });
    // An older client's streaming-only PATCH must keep newer display choices.
    await updateUserPreferences(f.owner, { streamingOutput: false });
    expect(
      await getUserPreferences({ ...f.owner, workspaceId: null }),
    ).toMatchObject({
      streamingOutput: false,
      fontSize: 18,
      transcriptView: 'compact',
      collapseTiming: 'next-input',
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
});
