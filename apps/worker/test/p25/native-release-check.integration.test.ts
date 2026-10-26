/** MET-221 PR2b: deploy-dev's pre-stop check of a release candidate
 * (scripts/dev-release/verify-native-retention.mjs wraps this function).
 * Owned PostgreSQL schema with every migration, including the archived drafts
 * 0213-0216 that M1 Dev applied; no Dev services are used. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DSH_INSTALLED_DISTRIBUTION } from '@allrice/contracts';
import * as client from '../../../../packages/database/src/core/client.ts';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { initializeNativeOncePartition } from '../../../../packages/database/src/native-schedule-once-product.ts';
import { NATIVE_JOURNAL_CONTRACT_KEY } from '../../../../packages/database/src/native-journal-contract-store.ts';
import { checkNativeReleaseCandidate } from '../../src/harness/dsh-native-release-check.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const primary = {
  artifactId: 'sha256:' + 'a'.repeat(64),
  generation: DSH_INSTALLED_DISTRIBUTION.generation,
};

suite('release candidate pre-stop check on the pre-0218 schema', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  let runtimeRoot: string;
  let stateRoot: string;
  const verifyControlHistory = vi.fn(async () => 0);
  const check = () =>
    checkNativeReleaseCandidate(primary, {
      sql: fixture.db,
      verifyControlHistory,
    });
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
    runtimeRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'allrice-release-check-runtime-')),
    );
    vi.stubEnv('ALLRICE_DSH_RUNTIME_ROOT', runtimeRoot);
    // The release tools still pass these; they are reported, never required.
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', 'sha256:' + 'b'.repeat(64));
    vi.stubEnv('ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS', '["not-read"]');
    // Empty retired settings, as compose.yaml writes them, are not settings.
    vi.stubEnv('ALLRICE_DSH_RETAINED_1_ROOT', '');
    vi.stubEnv('ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_PATH', '');
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120_000);
  afterAll(async () => {
    try {
      await fixture?.close();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(runtimeRoot, { recursive: true, force: true });
      if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('passes with the stale release settings and reports them', async () => {
    expect(await check()).toEqual({
      journalContract: {
        current: 1,
        readsFrom: 1,
        highWater: 1,
        recorded: false,
      },
      contexts: {
        incompatibleChats: 0,
        incompatiblePins: 0,
        controlPartitions: 0,
        controlSessionsVerified: 0,
      },
      ignoredSettings: [
        'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
        'ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS',
      ],
    });
  });

  it('refuses a non-empty retired setting and another generation', async () => {
    vi.stubEnv('ALLRICE_DSH_RETAINED_1_ROOT', '/retired/root');
    try {
      await expect(check()).rejects.toThrow(
        'DSH_NATIVE_ARTIFACT_RETIRED_SETTING ALLRICE_DSH_RETAINED_1_ROOT',
      );
    } finally {
      vi.stubEnv('ALLRICE_DSH_RETAINED_1_ROOT', '');
    }
    await expect(
      checkNativeReleaseCandidate(
        { ...primary, generation: 'dsh-0.1.5-rc.3-a4c74a9' },
        { sql: fixture.db, verifyControlHistory },
      ),
    ).rejects.toThrow('DSH_NATIVE_ARTIFACT_GENERATION');
  });

  it('refuses a database whose journals are newer, or whose row is malformed', async () => {
    const set = (value: Record<string, unknown>) => fixture.db`
      insert into allrice_runtime_metadata (key,value,updated_at)
      values (${NATIVE_JOURNAL_CONTRACT_KEY},${fixture.db.json(value as never)},now())
      on conflict (key) do update set value=excluded.value`;
    try {
      await set({ highWater: 2 });
      await expect(check()).rejects.toThrow(
        'DSH_NATIVE_JOURNAL_CONTRACT_AHEAD',
      );
      await set({ highWater: 1, extra: true });
      await expect(check()).rejects.toThrow(
        'DSH_NATIVE_JOURNAL_CONTRACT_INVALID',
      );
    } finally {
      await fixture.db`delete from allrice_runtime_metadata where key=${NATIVE_JOURNAL_CONTRACT_KEY}`;
    }
  });

  it('refuses a pin outside the deployment storage roots, except an archived chat', async () => {
    const f = await assistantFixture(fixture.db);
    const chat = f.task.chatSessionId;
    await fixture.db`insert into allrice_native_session_bindings
      (native_session_id,organization_id,workspace_id,owner_id,context_kind,context_id,storage_context_key,storage_namespace,
       artifact_id,artifact_manifest_digest,distribution_generation,profile_id,first_run_id,first_job_id,first_attempt,binding_basis,root_origin_digest)
      select ${'dsh-' + chat},organization_id,workspace_id,owner_id,'chat',id,id::text,'/moved-runtime/sessions',
        ${primary.artifactId},${primary.artifactId},${primary.generation},'restricted',${f.task.runId},${f.worker.jobId},1,
        'approved_compatibility_reader',null
      from allrice_chat_sessions where id=${chat}`;
    await expect(check()).rejects.toThrow('DSH_NATIVE_CONTEXT_STORAGE_MOVED 1');
    await fixture.db`update allrice_chat_sessions set archived_at=now() where id=${chat}`;
    expect((await check()).contexts.incompatibleChats).toBe(0);
  });

  it('verifies each control partition with the candidate and refuses a missing state root', async () => {
    stateRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'allrice-release-check-control-')),
    );
    const reference = {
      // Born under an earlier release of the generation: provenance only.
      artifactId: 'sha256:' + 'e'.repeat(64),
      profileId: 'allrice-once-control-v1',
      storageId: `release-check-${randomUUID()}`,
      stateRoot,
    };
    vi.stubEnv('ALLRICE_NATIVE_ONCE_REFERENCE', JSON.stringify(reference));
    await initializeNativeOncePartition(reference);
    expect((await check()).contexts.controlPartitions).toBe(1);
    expect(verifyControlHistory).toHaveBeenLastCalledWith(reference, []);
    await rm(stateRoot, { recursive: true, force: true });
    await expect(check()).rejects.toThrow(
      'DSH_NATIVE_CONTROL_HISTORY_UNREADABLE allrice-once-v1',
    );
  });
});
