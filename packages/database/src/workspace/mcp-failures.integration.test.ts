import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { createMcpExecutionFixture } from '../mcp-execution.fixture.ts';
import { runMcpRuntimeOperation } from '../../../../apps/worker/src/mcp/executor.js';
import { readSessionMcpFailures } from './mcp-failures.ts';
import { getChatSessionHistory } from './service.ts';
import * as client from '../core/client.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('historical MCP failure notices from scoped immutable receipts', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  let f: Awaited<ReturnType<typeof createMcpExecutionFixture>>;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', 'af'.repeat(32));
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    f = await createMcpExecutionFixture(fixture.db);
  }, 120000);
  afterAll(async () => {
    await f?.service.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  it('preserves a reported failure, projects it only after failure, and never dispatches from history', async () => {
    const c = await f.create();
    await f.decide(c);
    let calls = 0;
    const output = JSON.stringify({
      isError: true,
      error: { message: 'synthetic denied, secret must not reach notice' },
    });
    const result = await runMcpRuntimeOperation(c, {
      database: fixture.db,
      store: f.store,
      transport: {
        ...f.transport,
        invoke: async () => {
          calls++;
          return {
            isError: true,
            modelContent: output,
            rawOutput: JSON.parse(output),
            summary: 'remote error',
          };
        },
      },
    });
    expect(result).toMatchObject({
      status: 'unknown',
      code: 'MCP_REMOTE_ERROR_EFFECTS_UNKNOWN',
    });
    const read = (
      org = f.org,
      workspace = f.workspace,
      session = f.session,
      owner = f.user,
    ) => readSessionMcpFailures(org, workspace, session, owner, fixture.db);
    expect((await read()).size).toBe(0);
    await fixture.db`update allrice_runs set state='failed',error_code='ASSISTANT_EXECUTION_UNRESOLVED' where id=${f.run}`;
    expect((await read()).get(f.run)).toBe('remote_error');
    for (const args of [
      ['00000000-0000-4000-8000-000000000001', f.workspace, f.session, f.user],
      [f.org, '00000000-0000-4000-8000-000000000001', f.session, f.user],
      [f.org, f.workspace, '00000000-0000-4000-8000-000000000001', f.user],
      [f.org, f.workspace, f.session, '00000000-0000-4000-8000-000000000001'],
    ]) {
      expect(
        (await read(...(args as [string, string, string, string]))).size,
      ).toBe(0);
    }
    const before =
      await fixture.db`select snapshot from allrice_runtime_operations where id=${result.operationId}`;
    const history = await getChatSessionHistory(
      f.context,
      f.workspace,
      f.session,
    );
    expect(
      history.messages.find((m) => m.runId === f.run)?.applicationFailure,
    ).toBe('remote_error');
    expect(JSON.stringify(history)).not.toContain(
      'secret must not reach notice',
    );
    expect(
      await fixture.db`select snapshot from allrice_runtime_operations where id=${result.operationId}`,
    ).toEqual(before);
    expect(calls).toBe(1);
    await fixture.db`update allrice_runs set state='succeeded',error_code=null where id=${f.run}`;
    expect((await read()).size).toBe(0);
  });
});
