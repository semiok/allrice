/** Isolated PostgreSQL + real Broker + pinned native protocol; synthetic model only. */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  makeObjectKey,
  type ExecutionContext,
  type StorageObject,
} from '@allrice/contracts';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { admitsRootNativeFileRead } from '../../src/native-file-read-admission.js';
import { executeRiceTool } from '../../src/tool-broker.js';
import { nativeBrokerRoundtrip } from '../../src/harness/dsh-native-broker.fixture.js';
import { LocalStorageAdapter } from '@allrice/storage';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('file read ordinary-root source and real ACL refusal', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await fixture?.close();
  });
  async function setup() {
    const f = await createRunAuthorityFixture(fixture.db, {
      memberRole: 'member',
    });
    const [message] = await fixture.db<
      { user_message_id: string }[]
    >`select user_message_id from allrice_employee_runs where run_id=${f.rootRunId}`;
    const context: ExecutionContext = {
      executionId: randomUUID(),
      runId: f.rootRunId,
      jobId: f.worker.jobId,
      worker: { type: 'worker', id: f.worker.workerId },
      delegatedBy: { type: 'user', id: f.user },
      organizationId: f.org,
      workspaceId: f.workspace,
      startedAt: new Date().toISOString(),
      policySnapshot: {
        id: f.policy,
        organizationId: f.org,
        subjectId: f.user,
        version: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        memberships: [],
        grants: [
          {
            resourceType: 'storage_object',
            action: 'resource:read',
            workspaceId: f.workspace,
          },
        ],
      },
    };
    return { ...f, context, userMessageId: message!.user_message_id };
  }
  it('a scheduled producer carrying role=user keeps the old transport, including before its Run link is filled', async () => {
    const f = await setup(),
      automation = randomUUID(),
      occurrence = randomUUID();
    expect(await admitsRootNativeFileRead(f)).toBe(true);
    await fixture.db`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,schedule)
      values(${automation},${f.org},${f.workspace},${f.user},'Synthetic scheduled source','读取资料','{"frequency":"once"}')`;
    await fixture.db`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,scheduled_for)
      values(${occurrence},${f.org},${f.workspace},${automation},clock_timestamp())`;
    await fixture.db`update allrice_messages set client_message_id=${occurrence} where id=${f.userMessageId}`;
    expect(await admitsRootNativeFileRead(f)).toBe(false);
    await fixture.db`update allrice_automation_runs set run_id=${f.rootRunId} where id=${occurrence}`;
    expect(await admitsRootNativeFileRead(f)).toBe(false);
    expect(
      await admitsRootNativeFileRead({ ...f, userMessageId: randomUUID() }),
    ).toBe(false);
  });
  it('读取我之前保存的资料入口并完成核对: real private-file ACL denial is audited and becomes one safe native result, without storage access', async () => {
    const f = await setup(),
      other = await setup(),
      objectId = randomUUID();
    expect(await admitsRootNativeFileRead(f)).toBe(true);
    await fixture.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,visibility,state)
      values(${objectId},${f.org},${f.workspace},${other.user},${'synthetic/' + objectId},'uploads','text/plain',12,${'sha256:' + '0'.repeat(64)},'private','ready')`;
    const storage = vi.spyOn(LocalStorageAdapter.prototype, 'get');
    await nativeBrokerRoundtrip({
      prompt: '读取我之前保存的资料入口并完成核对。',
      fileReadRunId: f.rootRunId,
      canonicalName: 'workspace.file.read',
      wireName: 'workspace_file_read',
      args: { objectId, offset: 0, limit: 4000 },
      invalidArgs: { objectId, limit: 4001 },
      expectedToolError: 'TOOL_FILE_ACCESS_DENIED',
      onToolCall: (call) =>
        executeRiceTool({
          context: f.context,
          capabilities: ['storage:read'],
          storageRoot: fixture.storageRoot,
          call,
        }),
    });
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
    const audit =
      await fixture.db`select decision,reason,metadata from allrice_audit_events
      where metadata->>'runId'=${f.rootRunId} and metadata->>'toolName'='workspace.file.read'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      decision: 'denied',
      reason: 'tool_file_access_denied',
      metadata: {
        nativeCallId: 'call_1',
        errorCode: 'TOOL_FILE_ACCESS_DENIED',
      },
    });
  }, 45000);
  it('读取这份 CSV 并汇总渠道数据: the same native turn corrects file.read to document.read and completes with the original refusal audited', async () => {
    const f = await setup(),
      objectId = randomUUID();
    const content = 'channel,total\nsearch,42\nreferral,18\n';
    const object: StorageObject = {
      id: objectId,
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      key: makeObjectKey({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        category: 'uploads',
        objectId,
      }),
      mediaType: 'text/csv',
      sizeBytes: Buffer.byteLength(content),
      checksum: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      immutable: false,
      retentionUntil: null,
      deletedAt: null,
    };
    await fixture.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,visibility,state)
      values(${objectId},${f.org},${f.workspace},${f.user},${object.key},'uploads',${object.mediaType},${object.sizeBytes},${object.checksum},'private','ready')`;
    await new LocalStorageAdapter(fixture.storageRoot).put(
      object,
      new Blob([content]).stream(),
    );
    expect(await admitsRootNativeFileRead(f)).toBe(true);
    const calls: string[] = [];
    await nativeBrokerRoundtrip({
      prompt: '读取这份 CSV 并汇总渠道数据。',
      fileReadRunId: f.rootRunId,
      canonicalName: 'workspace.file.read',
      wireName: 'workspace_file_read',
      args: { objectId },
      invalidArgs: { objectId, limit: 4001 },
      expectedToolError: 'TOOL_FILE_TYPE_UNSUPPORTED',
      expectedBrokerCalls: 2,
      followupTool: {
        canonicalName: 'workspace.document.read',
        wireName: 'workspace_document_read',
        args: { objectId },
        modelResultIncludes: 'search,42',
      },
      onToolCall: async (call) => {
        calls.push(call.name);
        const result = await executeRiceTool({
          context: f.context,
          capabilities: ['storage:read'],
          storageRoot: fixture.storageRoot,
          call,
        });
        if (call.name === 'workspace.document.read') {
          expect(JSON.parse(result.modelContent)).toMatchObject({
            id: objectId,
            mediaType: 'text/csv',
            kind: 'text',
          });
          expect(result.modelContent).toContain('search,42');
        }
        return result;
      },
    });
    expect(calls).toEqual(['workspace.file.read', 'workspace.document.read']);
    const audit =
      await fixture.db`select decision,reason,metadata from allrice_audit_events where metadata->>'runId'=${f.rootRunId} and action='tool.execute' order by occurred_at`;
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      decision: 'denied',
      reason: 'tool_file_type_unsupported',
      metadata: {
        toolName: 'workspace.file.read',
        nativeCallId: 'call_1',
        errorCode: 'TOOL_FILE_TYPE_UNSUPPORTED',
        retryable: false,
      },
    });
    expect(audit[1]).toMatchObject({
      decision: 'allowed',
      metadata: { toolName: 'workspace.document.read' },
    });
  }, 45000);
});
