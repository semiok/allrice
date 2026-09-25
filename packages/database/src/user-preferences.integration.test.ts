import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  it('defaults off, persists for a normal member across workspaces, and isolates other users', async () => {
    const f = await createExperienceFixture(fixture.db);
    expect(await getUserPreferences(f.owner)).toEqual({
      streamingOutput: false,
      updatedAt: null,
    });
    const saved = await updateUserPreferences(f.owner, {
      streamingOutput: true,
    });
    expect(saved.streamingOutput).toBe(true);
    expect(saved.updatedAt).not.toBeNull();
    expect(await getUserPreferences({ ...f.owner, workspaceId: null })).toEqual(
      saved,
    );
    expect(await getUserPreferences(f.neighbor)).toEqual({
      streamingOutput: false,
      updatedAt: null,
    });
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
});
