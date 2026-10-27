import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { sendChatMessage } from './workspace/service.ts';
import {
  getUserPreferences,
  updateUserPreferences,
} from './user-preferences.ts';

let isolated: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => isolated.db,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

type Fixture = Awaited<ReturnType<typeof createExperienceFixture>>;
// What a member types in the chat; the Run is frozen when it is queued.
async function send(f: Fixture) {
  const sent = await sendChatMessage(f.owner, f.workspace, f.session.id, {
    clientMessageId: randomUUID(),
    text: '帮我整理这周的周报，需要的话先问我。',
    deliveryMode: 'follow_up',
  });
  return sent.run.id;
}
async function snapshotOf(runId: string) {
  const [row] = await isolated.db<{ snapshot: Record<string, unknown> }[]>`
    select execution_snapshot as snapshot from allrice_employee_runs where run_id=${runId}`;
  return row!.snapshot.nativePreferences;
}
const frozen = async (f: Fixture) => snapshotOf(await send(f));
const policy = (f: Fixture, controls: unknown) => isolated.db`
  insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls)
  values (${f.org},${f.workspace},1,${isolated.db.json(controls as never)})
  on conflict (organization_id,workspace_id) do update set controls=excluded.controls`;
const controls = (effect?: 'deny' | 'ask' | 'allow') => ({
  version: 1,
  enabled: true,
  mode: 'execute',
  rules: effect ? [{ action: 'assistant.delegate', effect }] : [],
});

// MET-210 (user 10-27): question wait and subagent limits are the member's own
// DSH settings, frozen into each Run they start (plan v4.2, PR2).
suite('MET-210 agent preferences frozen into each Run', () => {
  beforeAll(async () => {
    isolated = await createAssistantFixtureDatabase();
  }, 120000);
  afterAll(async () => {
    await isolated?.close();
  });

  it('freezes default preferences with delegation closed when no policy is stored', async () => {
    const f = await createExperienceFixture(isolated.db);
    expect(await frozen(f)).toEqual({
      version: 1,
      questionWait: { mode: 'default' },
      subagents: { maxDepth: 0, maxActive: null },
    });
  });

  it('freezes null overrides when the tenant allows delegation and the member never chose', async () => {
    const f = await createExperienceFixture(isolated.db);
    await policy(f, controls('allow'));
    expect(await frozen(f)).toEqual({
      version: 1,
      questionWait: { mode: 'default' },
      subagents: { maxDepth: null, maxActive: null },
    });
  });

  it('freezes the saved choice at the next message, and an earlier Run keeps its own', async () => {
    const f = await createExperienceFixture(isolated.db);
    await policy(f, controls('allow'));
    await updateUserPreferences(f.owner, {
      questionWait: { mode: 'timed', seconds: 300 },
      subagents: { maxDepth: 2, maxActive: 3 },
    });
    const firstRun = await send(f);
    const first = await snapshotOf(firstRun);
    expect(first).toEqual({
      version: 1,
      questionWait: { mode: 'timed', seconds: 300 },
      subagents: { maxDepth: 2, maxActive: 3 },
    });
    await updateUserPreferences(f.owner, { questionWait: { mode: 'forever' } });
    expect(await frozen(f)).toMatchObject({
      questionWait: { mode: 'forever' },
      subagents: { maxDepth: 2, maxActive: 3 },
    });
    expect(await snapshotOf(firstRun)).toEqual(first);
    await updateUserPreferences(f.owner, {
      questionWait: { mode: 'default' },
      subagents: { maxDepth: null, maxActive: null },
    });
    expect(await frozen(f)).toEqual({
      version: 1,
      questionWait: { mode: 'default' },
      subagents: { maxDepth: null, maxActive: null },
    });
    expect(await snapshotOf(firstRun)).toEqual(first);
  });

  it.each([
    ['deny', 0],
    ['ask', 0],
    ['allow', 4],
    [undefined, 0],
  ] as const)(
    'a tenant assistant.delegate %s rule freezes subagent depth %i',
    async (effect, maxDepth) => {
      const f = await createExperienceFixture(isolated.db);
      await updateUserPreferences(f.owner, {
        subagents: { maxDepth: 4, maxActive: 2 },
      });
      await policy(f, controls(effect));
      expect(await frozen(f)).toMatchObject({
        subagents: { maxDepth, maxActive: 2 },
      });
      expect(await getUserPreferences(f.owner)).toMatchObject({
        subagents: { maxDepth: 4, maxActive: 2 },
      });
    },
  );

  it.each([
    ['disabled', { ...controls('allow'), enabled: false }],
    ['plan only', { ...controls('allow'), mode: 'plan_only' }],
    [
      'explicit deny alongside allow',
      {
        ...controls('allow'),
        rules: [
          { action: 'assistant.delegate', effect: 'allow' },
          { action: 'assistant.delegate', effect: 'deny' },
        ],
      },
    ],
  ])('closes delegation for a %s policy even with allow', async (_, value) => {
    const f = await createExperienceFixture(isolated.db);
    await updateUserPreferences(f.owner, {
      subagents: { maxDepth: 4, maxActive: 2 },
    });
    await policy(f, value);
    expect(await frozen(f)).toMatchObject({
      subagents: { maxDepth: 0, maxActive: 2 },
    });
  });

  it('a stored policy that does not parse closes delegation', async () => {
    const f = await createExperienceFixture(isolated.db);
    await policy(f, { version: 1, rules: 'not a policy' });
    expect(await frozen(f)).toMatchObject({
      subagents: { maxDepth: 0, maxActive: null },
    });
  });

  it('closes delegation for a policy version mismatch without overwriting the saved choice', async () => {
    const f = await createExperienceFixture(isolated.db);
    await updateUserPreferences(f.owner, {
      subagents: { maxDepth: 4, maxActive: null },
    });
    // The stored row remains version 1; its otherwise valid JSON says 2.
    await policy(f, { ...controls('allow'), version: 2 });
    expect(await frozen(f)).toMatchObject({
      subagents: { maxDepth: 0, maxActive: null },
    });
    expect(await getUserPreferences(f.owner)).toMatchObject({
      subagents: { maxDepth: 4, maxActive: null },
    });
  });
});
