import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from '../local-command-assistant.fixture.ts';
import { createLocalCommandOperation } from '../local-command-service.ts';
import { appendJobEvent } from '../execution/queue.ts';
import * as client from '../core/client.ts';
import { getChatSessionHistory } from './service.ts';
import { readSessionWorkMethods } from './work-methods.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('message work methods from durable execution receipts', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    for (const flag of [
      'ALLRICE_ASSISTANTS_ENABLED',
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
    ])
      vi.stubEnv(flag, '1');
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  const setup = () =>
    createAssistantLocalCommandFixture(fixture.db, 'ask', false, {
      skipChild: true,
    });
  it('ignores plain prose, tool intents and unavailable async returns; deduplicates actual completed work in history', async () => {
    const f = await setup();
    const read = () =>
      readSessionWorkMethods(f.org, f.workspace, f.session, f.db);
    expect((await read()).size).toBe(0);
    for (const [type, name] of [
      ['tool.started', 'web.fetch'],
      ['tool.failed', 'local.fs.read'],
      ['tool.completed', 'local.process.execute'],
      ['tool.completed', 'cloud.mcp.call'],
      ['tool.completed', 'local.preview.open'],
      ['tool.completed', 'workspace.skill.read'],
      ['tool.completed', 'assistant.delegate'],
    ] as const)
      await appendJobEvent({
        ...f.worker,
        type,
        payload: { source: 'dsh', name, toolCallId: randomUUID() },
      });
    expect((await read()).size).toBe(0);
    for (const name of [
      'web.fetch',
      'web.search',
      'workspace.export.create',
      'automation.create',
      'local.fs.read',
    ])
      await appendJobEvent({
        ...f.worker,
        type: 'tool.completed',
        payload: { source: 'dsh', name, toolCallId: randomUUID() },
      });
    expect((await read()).get(f.rootRunId)).toEqual([
      'cloud_search',
      'cloud_files',
      'cloud_automation',
      'bridge_files',
    ]);
    const history = await getChatSessionHistory(
      {
        ...f.requestContext,
        memberships: f.context.policySnapshot.memberships,
      },
      f.workspace,
      f.session,
    );
    expect(
      history.messages.find((m) => m.runId === f.rootRunId)?.workMethods,
    ).toEqual([
      'cloud_search',
      'cloud_files',
      'cloud_automation',
      'bridge_files',
    ]);
    const other = await setup();
    expect(
      (await readSessionWorkMethods(other.org, f.workspace, f.session, f.db))
        .size,
    ).toBe(0);
    expect(
      (await readSessionWorkMethods(f.org, other.workspace, f.session, f.db))
        .size,
    ).toBe(0);
    await expect(
      getChatSessionHistory(other.requestContext, f.workspace, f.session),
    ).rejects.toThrow();
  });
  it('does not mark waiting or dispatched work as executed; retains a started Bridge attempt after failure', async () => {
    const f = await setup();
    const read = async () =>
      (await readSessionWorkMethods(f.org, f.workspace, f.session, f.db)).get(
        f.rootRunId,
      ) ?? [];
    const operation = await createLocalCommandOperation(
      { context: f.context, arguments: f.args, callId: randomUUID() },
      f.db,
    );
    const operationId = operation.snapshot.binding.attempt.operationId;
    expect(await read()).toEqual([]);
    await f.approve(await f.approvalFor(operationId));
    const ledger = f.freshLedger(),
      scope = operation.snapshot.binding.task.scope;
    const lease = await ledger.dispatch({
      scope,
      operationId,
      leaseOwner: randomUUID(),
      leaseMs: 60000,
    });
    expect(await read()).toEqual([]);
    const receipt = {
      scope,
      operationId,
      leaseToken: lease.leaseToken,
      attempt: lease.snapshot.binding.attempt,
    };
    const started = await ledger.startOperation({
      ...receipt,
      receiptId: randomUUID(),
    });
    expect(started.snapshot.processId).toBeNull();
    expect(await read()).toEqual(['bridge_compute']);
    await ledger.recordReceipt({
      ...receipt,
      receiptId: randomUUID(),
      signal: {
        type: 'operation.outcome',
        result: {
          status: 'failed',
          effects: 'none',
          evidence: {
            id: randomUUID(),
            recordedAt: new Date().toISOString(),
            digest: `sha256:${'a'.repeat(64)}`,
          },
        },
      },
    });
    expect(await read()).toEqual(['bridge_compute']);
  });
});
