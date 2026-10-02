/** Real isolated PostgreSQL; no model, renderer, Bridge or business data. */
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ExecutionContextSchema,
  RuntimeOperationSnapshotSchema,
  type EmployeeExecutionSnapshot,
} from '@allrice/contracts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';
import { publishWorkbenchArtifact } from './artifact-review.ts';
import {
  createToolBrokerExportObject,
  registerToolBrokerExport,
} from './execution/tool-broker.ts';
import { selectOfficePdfExecution } from './office-pdf-execution.ts';
import * as client from './core/client.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const hash = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
suite(
  'MET166 Office PDF provider authority and independent format lineage',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '0');
      database = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
    }, 60000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await database?.close();
    });
    async function fixture(
      options: {
        message?: string;
        missing?: 'storage:read' | 'storage:write';
      } = {},
    ) {
      const f = await createAssistantAuthorityFixture(database.db, {
        allowedTools: ['workspace.export.create', 'workspace.document.read'],
        memberRole: 'member',
        configure: false,
        snapshot: (frozen: EmployeeExecutionSnapshot) => ({
          ...frozen,
          capabilitySnapshot: {
            ...frozen.capabilitySnapshot,
            grantedCapabilities:
              frozen.capabilitySnapshot.grantedCapabilities.filter(
                (c) => c !== options.missing,
              ),
          },
        }),
      });
      const db = database.db;
      const [p] =
        await db`select payload,issued_at,expires_at from allrice_policy_snapshots where id=${f.policy}`;
      const context = ExecutionContextSchema.parse({
        executionId: randomUUID(),
        runId: f.rootRunId,
        jobId: f.worker.jobId,
        worker: { type: 'worker', id: f.worker.workerId },
        delegatedBy: { type: 'user', id: f.user },
        organizationId: f.org,
        workspaceId: f.workspace,
        policySnapshot: {
          id: f.policy,
          organizationId: f.org,
          subjectId: f.user,
          version: 1,
          issuedAt: p!.issued_at.toISOString(),
          expiresAt: p!.expires_at.toISOString(),
          ...p!.payload,
        },
        startedAt: new Date().toISOString(),
      });
      context.policySnapshot.grants.push({
        resourceType: 'storage_object',
        action: 'resource:read',
        workspaceId: f.workspace,
      });
      await db`update allrice_policy_snapshots set payload=${db.json({ memberships: context.policySnapshot.memberships, grants: context.policySnapshot.grants })} where id=${f.policy}`;
      if (options.message)
        await db`update allrice_messages set content=${db.json({ text: options.message, citations: [] })} where id=(select user_message_id from allrice_employee_runs where run_id=${f.rootRunId})`;
      const [job] = await db<
        { attempt: number; lease_token: string }[]
      >`select attempt,lease_token from allrice_jobs where id=${f.worker.jobId}`;
      const storage = assistantFixtureStorage(db);
      const publish = (
        format: 'docx' | 'pdf' | 'text',
        sourceFile?: { objectId: string; checksum: string },
        parentObjectId?: string,
        trustedOfficePdfLease?: { jobAttempt: number; jobLeaseToken: string },
      ) =>
        publishWorkbenchArtifact(
          {
            context,
            sessionId: f.session,
            callId: randomUUID(),
            kind: 'document',
            fileName: `fixture.${format}`,
            format,
            bytes: Buffer.from(`synthetic ${format} ${randomUUID()}`),
            mediaType:
              format === 'pdf'
                ? 'application/pdf'
                : format === 'docx'
                  ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                  : 'text/plain',
            ...(sourceFile ? { sourceFile } : {}),
            ...(parentObjectId ? { parentObjectId } : {}),
            ...(trustedOfficePdfLease ? { trustedOfficePdfLease } : {}),
          },
          storage,
          db,
        );
      let source: Awaited<ReturnType<typeof publish>>;
      if (options.missing === 'storage:write') {
        const bytes = Buffer.from('isolated existing Word source');
        const object = createToolBrokerExportObject({
          context,
          mediaType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: bytes.length,
          checksum: hash(bytes),
        });
        await storage.put(object, new Blob([bytes]).stream());
        const version = await registerToolBrokerExport(
          {
            context,
            sessionId: f.session,
            fileName: 'existing.docx',
            format: 'docx',
            object,
          },
          db,
        );
        source = { object, version } as typeof source;
      } else source = await publish('docx');
      const officePdf = {
        objectId: source.object.id,
        checksum: source.object.checksum,
      };
      const select = (
        location?: 'auto' | 'local' | 'cloud',
        overrides: Record<string, unknown> = {},
      ) => {
        const args = {
          fileName: 'fixture.pdf',
          format: 'pdf',
          officePdf,
          ...(location ? { location } : {}),
        };
        return {
          context,
          callId: randomUUID(),
          arguments: args,
          officePdf,
          jobAttempt: job!.attempt,
          jobLeaseToken: job!.lease_token,
          ...(location ? { location } : {}),
          ...overrides,
        };
      };
      return { ...f, context, storage, publish, source, officePdf, select };
    }
    it('selects only the server converter without Python/Node grants, records exact raw args, and binds once', async () => {
      const f = await fixture(),
        input = f.select();
      const original = structuredClone(input.arguments);
      const result = await selectOfficePdfExecution(input, database.db);
      expect(result).toMatchObject({
        choice: {
          location: 'cloud',
          status: 'execute',
          reason: 'local_unsupported',
        },
        source: {
          source: f.officePdf,
          parentObjectId: undefined,
          derivation: true,
        },
      });
      expect(input.arguments).toEqual(original);
      expect(input.arguments).not.toHaveProperty('location');
      expect(await selectOfficePdfExecution(input, database.db)).toMatchObject({
        choice: {
          location: 'cloud',
          status: 'execute',
          reason: 'bound_execution',
        },
        selectionId: result.selectionId,
      });
      const audit =
        await database.db`select metadata from allrice_audit_events where resource_id=${result.selectionId} and action='execution.location'`;
      expect(audit).toHaveLength(1);
      expect(audit[0]!.metadata.localInputs).toBe(false);
      await expect(
        selectOfficePdfExecution(
          {
            ...input,
            arguments: { ...input.arguments, fileName: 'changed.pdf' },
          },
          database.db,
        ),
      ).rejects.toThrow('idempotency_conflict');
      const pdf = await f.publish('pdf', f.officePdf, undefined, {
        jobAttempt: input.jobAttempt,
        jobLeaseToken: input.jobLeaseToken,
      });
      expect(pdf.provenance.kind).toBe('tool_result');
      expect(pdf.version.version).toBe(1);
      expect(
        await database.db`select id from allrice_runtime_operations where run_id=${f.rootRunId}`,
      ).toHaveLength(0);
    });
    it.each([
      '不要上传到云端，只在本地处理',
      'Do not upload these bytes',
      '在我的电脑上执行转换',
    ])(
      'original message overrides model cloud before any source IO: %s',
      async (message) => {
        const f = await fixture({ message }),
          missing = {
            objectId: randomUUID(),
            checksum: hash(Buffer.from('missing')),
          };
        const input = f.select('cloud');
        input.officePdf = missing;
        input.arguments.officePdf = missing;
        expect(
          await selectOfficePdfExecution(input, database.db),
        ).toMatchObject({ choice: { status: 'unavailable' }, source: null });
      },
    );
    it('explicit local is unsupported before source IO, and stale job lease/raw source mismatch are denied', async () => {
      const f = await fixture(),
        missing = {
          objectId: randomUUID(),
          checksum: hash(Buffer.from('missing')),
        };
      const input = f.select('local');
      input.officePdf = missing;
      input.arguments.officePdf = missing;
      expect(await selectOfficePdfExecution(input, database.db)).toMatchObject({
        choice: {
          location: 'local',
          status: 'unavailable',
          reason: 'local_unsupported',
        },
        source: null,
      });
      await expect(
        selectOfficePdfExecution(
          { ...f.select(), jobLeaseToken: randomUUID() },
          database.db,
        ),
      ).rejects.toThrow('run_or_frozen_configuration_changed');
      await expect(
        selectOfficePdfExecution(
          { ...f.select(), officePdf: missing },
          database.db,
        ),
      ).rejects.toThrow('invalid_tool_call');
    });
    it('a Run already bound to local file inputs cannot use model cloud conversion', async () => {
      const f = await fixture(),
        db = database.db;
      const device = randomUUID(),
        target = randomUUID(),
        grant = randomUUID();
      await db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash) values(${device},${f.org},${f.workspace},${f.user},'Isolated fixture device','macos-x64',2,array['local.fs.read'],${'a'.repeat(64)})`;
      await db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities) values(${target},${f.org},${f.workspace},${`bridge.${device}`},'rice_bridge','Isolated fixture target','offline','[]')`;
      const snapshot = RuntimeOperationSnapshotSchema.parse({
        contractVersion: 1,
        binding: {
          task: f.task,
          attempt: {
            operationId: randomUUID(),
            attemptId: randomUUID(),
            attemptNumber: 1,
            generation: 0,
            fence: 1,
          },
          requestedBy: { type: 'user', id: f.user },
          policy: {
            snapshotId: f.policy,
            digest: hash(Buffer.from('isolated fixture')),
          },
          execution: {
            targetId: target,
            targetKind: 'rice_bridge',
            deviceId: device,
            grantId: grant,
            grantVersion: 1,
            scopeDigest: hash(Buffer.from('isolated fixture')),
            workCopy: { id: grant, kind: 'in_place' },
          },
          action: 'local.fs.read',
          inputDigest: hash(Buffer.from('isolated fixture')),
          dataScope: [],
          baseline: [],
          command: null,
        },
        stepId: null,
        agentInstanceId: null,
        processId: null,
        cancelRequestId: null,
        idempotencyKey: randomUUID(),
        status: 'planned',
        result: null,
      });
      const b = snapshot.binding;
      // A planned immutable fixture reservation is sufficient to bind local
      // inputs; this does not claim an executed read or fake physical receipt.
      await db`insert into allrice_runtime_operations(id,organization_id,workspace_id,run_id,root_run_id,target_id,device_id,attempt_id,attempt_number,generation,fence,idempotency_key,initial_snapshot,snapshot)
        values(${b.attempt.operationId},${f.org},${f.workspace},${f.rootRunId},${f.rootRunId},${target},${device},${b.attempt.attemptId},1,0,1,${snapshot.idempotencyKey},${db.json(snapshot)},${db.json(snapshot)})`;
      const input = f.select('cloud'),
        missing = {
          objectId: randomUUID(),
          checksum: hash(Buffer.from('missing')),
        };
      input.officePdf = missing;
      input.arguments.officePdf = missing;
      expect(await selectOfficePdfExecution(input, db)).toMatchObject({
        choice: { status: 'unavailable', reason: 'local_inputs_required' },
        source: null,
      });
    });
    it.each(['storage:read', 'storage:write'] as const)(
      'does not grant missing frozen %s',
      async (missing) => {
        const f = await fixture({ missing });
        await expect(
          selectOfficePdfExecution(f.select(), database.db),
        ).rejects.toThrow('run_or_frozen_configuration_changed');
      },
    );
    it('checks read grant, source checksum, same owner, and foreign context before conversion', async () => {
      const f = await fixture(),
        input = f.select();
      const withoutRead = structuredClone(input.context);
      withoutRead.policySnapshot.grants =
        withoutRead.policySnapshot.grants.filter(
          (x) => x.action !== 'resource:read',
        );
      await expect(
        selectOfficePdfExecution(
          { ...input, context: withoutRead },
          database.db,
        ),
      ).rejects.toThrow('authorization_denied');
      const other = await fixture();
      await expect(
        selectOfficePdfExecution(
          { ...input, context: other.context },
          database.db,
        ),
      ).rejects.toThrow('run_or_frozen_configuration_changed');
      const privateSource = createToolBrokerExportObject({
        context: f.context,
        mediaType: f.source.object.mediaType,
        sizeBytes: f.source.object.sizeBytes,
        checksum: f.source.object.checksum,
      });
      await database.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,visibility,state,immutable) values(${privateSource.id},${f.org},${f.workspace},${other.user},${privateSource.key},'uploads',${privateSource.mediaType},${privateSource.sizeBytes},${privateSource.checksum},'private','ready',false)`;
      const foreignSource = {
        objectId: privateSource.id,
        checksum: privateSource.checksum,
      };
      await expect(
        selectOfficePdfExecution(
          {
            ...input,
            officePdf: foreignSource,
            arguments: { ...input.arguments, officePdf: foreignSource },
          },
          database.db,
        ),
      ).rejects.toThrow('authorization_denied');
      const stale = { ...f.officePdf, checksum: hash(Buffer.from('changed')) };
      await expect(
        selectOfficePdfExecution(
          {
            ...input,
            officePdf: stale,
            arguments: { ...input.arguments, officePdf: stale },
          },
          database.db,
        ),
      ).rejects.toThrow('source_file_changed');
    });
    it('starts PDF independently and revises the PDF with a new Word source, preserving both Word versions', async () => {
      const f = await fixture();
      const pdf = await f.publish('pdf', f.officePdf);
      expect(pdf.version.version).toBe(1);
      expect(pdf.version.parentObjectId).toBeNull();
      expect(pdf.version.seriesId).not.toBe(f.source.version.seriesId);
      const revisedWord = await f.publish('docx', f.officePdf);
      expect(revisedWord.version).toMatchObject({
        version: 2,
        seriesId: f.source.version.seriesId,
      });
      const newSource = {
        objectId: revisedWord.object.id,
        checksum: revisedWord.object.checksum,
      };
      const pdf2 = await f.publish('pdf', newSource, pdf.object.id);
      expect(pdf2.version).toMatchObject({
        version: 2,
        seriesId: pdf.version.seriesId,
        parentObjectId: pdf.object.id,
      });
      const words =
        await database.db`select object_id,format from allrice_deliverable_versions where series_id=${f.source.version.seriesId} order by version`;
      expect(words.map((x) => x.format)).toEqual(['docx', 'docx']);
      const [audit] =
        await database.db`select metadata,reason from allrice_audit_events where action='artifact.source' and resource_id=${pdf2.id}`;
      expect(audit!.metadata.sourceFile).toEqual(newSource);
      expect(audit!.reason).toBe('source_file_derivation');
      const put = vi.spyOn(f.storage, 'put');
      await expect(
        f.publish('pdf', newSource, revisedWord.object.id),
      ).rejects.toThrow('version_changed');
      expect(put).not.toHaveBeenCalled();
      const foreign = await fixture(),
        foreignPdf = await foreign.publish('pdf', foreign.officePdf);
      put.mockClear();
      await expect(
        f.publish('pdf', newSource, foreignPdf.object.id),
      ).rejects.toThrow('artifact_not_found');
      expect(put).not.toHaveBeenCalled();
      const siblingSession = randomUUID();
      await database.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
        values(${siblingSession},${f.org},${f.workspace},${f.user},'Isolated sibling Session',${f.assignment},${f.version})`;
      const siblingPdf = createToolBrokerExportObject({
        context: f.context,
        mediaType: 'application/pdf',
        sizeBytes: 3,
        checksum: hash(Buffer.from('pdf')),
      });
      await registerToolBrokerExport(
        {
          context: f.context,
          sessionId: siblingSession,
          fileName: 'sibling.pdf',
          format: 'pdf',
          object: siblingPdf,
        },
        database.db,
      );
      put.mockClear();
      await expect(f.publish('pdf', newSource, siblingPdf.id)).rejects.toThrow(
        'artifact_not_found',
      );
      expect(put).not.toHaveBeenCalled();
    });
    it('retains identical reupload editing and rejects changed reuploads and cross-format direct parents', async () => {
      const f = await fixture();
      const upload = createToolBrokerExportObject({
        context: f.context,
        mediaType: f.source.object.mediaType,
        sizeBytes: f.source.object.sizeBytes,
        checksum: f.source.object.checksum,
      });
      await database.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,visibility,state,immutable) values(${upload.id},${upload.organizationId},${upload.workspaceId},${upload.ownerId},${upload.key},'uploads',${upload.mediaType},${upload.sizeBytes},${upload.checksum},'private','ready',false)`;
      const source = { objectId: upload.id, checksum: upload.checksum };
      expect(
        (await f.publish('docx', source, f.source.object.id)).version,
      ).toMatchObject({ version: 2, seriesId: f.source.version.seriesId });
      const put = vi.spyOn(f.storage, 'put');
      put.mockClear();
      await database.db`update allrice_storage_objects set checksum=${hash(Buffer.from('changed'))} where id=${upload.id}`;
      await expect(
        f.publish(
          'docx',
          { ...source, checksum: hash(Buffer.from('changed')) },
          f.source.object.id,
        ),
      ).rejects.toThrow('version_changed');
      expect(put).not.toHaveBeenCalled();
      const object = createToolBrokerExportObject({
        context: f.context,
        mediaType: 'application/pdf',
        sizeBytes: 3,
        checksum: hash(Buffer.from('pdf')),
      });
      await expect(
        registerToolBrokerExport(
          {
            context: f.context,
            sessionId: f.session,
            fileName: 'wrong.pdf',
            format: 'pdf',
            object,
            parentObjectId: f.source.object.id,
          },
          database.db,
        ),
      ).rejects.toThrow('not_found');
      expect(
        await database.db`select id from allrice_storage_objects where id=${object.id}`,
      ).toHaveLength(0);
    });
    it('rejects an originating converter attempt after lease replacement without writing any formal PDF', async () => {
      const f = await fixture(),
        input = f.select();
      expect(
        (await selectOfficePdfExecution(input, database.db)).choice.status,
      ).toBe('execute');
      const originalLease = {
        jobAttempt: input.jobAttempt,
        jobLeaseToken: input.jobLeaseToken,
      };
      await database.db`update allrice_jobs set attempt=attempt+1,lease_token=${randomUUID()} where id=${f.worker.jobId}`;
      const put = vi.spyOn(f.storage, 'put');
      put.mockClear();
      await expect(
        f.publish('pdf', f.officePdf, undefined, originalLease),
      ).rejects.toThrow('run_unavailable');
      expect(put).not.toHaveBeenCalled();
      expect(
        await database.db`select id from allrice_deliverable_versions where session_id=${f.session} and format='pdf'`,
      ).toHaveLength(0);
      expect(await f.storage.exists(f.source.object)).toBe(true);
    });
    it('rolls back PDF metadata and newly stored bytes when the exact lease expires during publication', async () => {
      const f = await fixture(),
        input = f.select();
      await selectOfficePdfExecution(input, database.db);
      const originalPut = f.storage.put.bind(f.storage);
      let written: Parameters<typeof originalPut>[0] | undefined;
      const put = vi
        .spyOn(f.storage, 'put')
        .mockImplementationOnce(async (object, bytes) => {
          written = object;
          await originalPut(object, bytes);
          await delay(300);
        });
      await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '250 milliseconds' where id=${f.worker.jobId}`;
      await expect(
        f.publish('pdf', f.officePdf, undefined, {
          jobAttempt: input.jobAttempt,
          jobLeaseToken: input.jobLeaseToken,
        }),
      ).rejects.toThrow('run_unavailable');
      expect(written).toBeDefined();
      expect(await f.storage.exists(written!)).toBe(false);
      expect(await f.storage.exists(f.source.object)).toBe(true);
      expect(
        await database.db`select id from allrice_deliverable_versions where session_id=${f.session} and format='pdf'`,
      ).toHaveLength(0);
      expect(
        await database.db`select id from allrice_storage_objects where id=${written!.id}`,
      ).toHaveLength(0);
      put.mockRestore();
    });
  },
);
