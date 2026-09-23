import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkerCapabilitySnapshot } from '@allrice/contracts';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from '../assistant-runtime.fixture.ts';
import {
  readRuntimeCapabilityInventory,
  recordWorkerCapabilities,
  removeWorkerCapabilities,
} from './runtime-capabilities.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('capability facts from PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    fixture = await createAssistantFixtureDatabase();
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
    vi.unstubAllEnvs();
  });
  it('expires missing Worker heartbeats and removes orderly shutdown reports', async () => {
    const snapshot: WorkerCapabilitySnapshot = {
      schemaVersion: 1,
      workerId: randomUUID(),
      releaseSha: null,
      version: 'synthetic',
      profileStatus: 'read',
      profileDigest: null,
      components: [],
      tools: [],
    };
    await recordWorkerCapabilities(snapshot, fixture.db);
    expect((await readRuntimeCapabilityInventory(fixture.db)).workers).toEqual([
      expect.objectContaining({ workerId: snapshot.workerId, online: true }),
    ]);
    await fixture.db`update allrice_runtime_metadata set updated_at=now()-interval '21 seconds' where key=${'dsh-worker-capabilities:' + snapshot.workerId}`;
    expect(
      (await readRuntimeCapabilityInventory(fixture.db)).workers[0]?.online,
    ).toBe(false);
    await removeWorkerCapabilities(snapshot.workerId, fixture.db);
    expect((await readRuntimeCapabilityInventory(fixture.db)).workers).toEqual(
      [],
    );
  });
  it('reads actual assigned tenant versions and excludes revoked memberships', async () => {
    await assistantFixture(fixture.db);
    // A newer unassigned version must not replace the version users actually receive.
    await fixture.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
      select ${randomUUID()},organization_id,workspace_id,employee_id,version+1,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot
      from allrice_employee_versions`;
    const inventory = await readRuntimeCapabilityInventory(fixture.db);
    expect(inventory.publications).toHaveLength(1);
    expect(inventory.publications[0]).toMatchObject({
      version: 1,
      skillIds: [],
      policyEnabled: false,
      toolNames: expect.arrayContaining([
        'assistant.delegate',
        'assistant.report',
      ]),
    });
    await fixture.db`update allrice_memberships set active=false`;
    expect(
      (await readRuntimeCapabilityInventory(fixture.db)).publications,
    ).toEqual([]);
  });
});
