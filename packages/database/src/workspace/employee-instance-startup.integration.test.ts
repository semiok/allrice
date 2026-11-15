import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createRunAuthorityFixture } from '../run-authority.fixture.ts';
import { authenticateSession, createSession } from '../identity.ts';
import {
  changeEmployeeInstanceLifecycle,
  ensureGeneralEmployeeInstance,
} from '../employees/employee-instances.ts';
import {
  createPersonalEmployeeMemory,
  getEmployeeWorkspace,
} from './service.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('employee instance workspace startup', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;

  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await fixture?.close();
  });

  it('keeps workspace startup available after a general instance is archived without reviving it', async () => {
    const f = await createRunAuthorityFixture(fixture.db);
    const context = (await authenticateSession(
      (await createSession(f.user)).token,
      { organizationId: f.org, workspaceId: f.workspace },
    ))!;
    await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
    const memory = await createPersonalEmployeeMemory(context, {
      workspaceId: f.workspace,
      instanceId: f.assignment,
      idempotencyKey: randomUUID(),
      summary: 'Personal source',
      details: 'Owner-authored current pair',
    });
    await changeEmployeeInstanceLifecycle(context, f.assignment, {
      workspaceId: f.workspace,
      requestId: randomUUID(),
      expectedRevision: 1,
      operation: 'archive',
    });

    const workspace = await getEmployeeWorkspace(context, f.workspace);
    expect(workspace.memories).toEqual([]);
    const instances = await fixture.db<{ archived_at: Date | null }[]>`
      select archived_at from allrice_employee_instances where id=${f.assignment}`;
    expect(instances).toHaveLength(1);
    expect(instances[0]!.archived_at).not.toBeNull();
    const [retained] = await fixture.db<{ instance_id: string }[]>`
      select instance_id from allrice_memories where id=${memory.id}`;
    expect(retained?.instance_id).toBe(f.assignment);
  });
});
