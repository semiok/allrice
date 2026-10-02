/** Real PostgreSQL authority in a per-UUID schema; no VM, pairing or model call. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BridgeDeviceSchema,
  EmployeeExecutionSnapshotSchema,
  ExecutionContextSchema,
  PlatformEmployeeDefinitionSchema,
  RuntimeLocalPdfPayloadSchema,
  RuntimeLocalPdfProfileSchema,
  RuntimeLocalPdfResultSchema,
  localPdfInputBytesV1,
  localPdfMemoryBudgetBytesV1,
  localPdfResultBytesV1,
  localPdfTimeoutMsV1,
  type RequestContext,
  type RuntimeLocalPdfPayload,
} from '@allrice/contracts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import { heartbeatBridgeDevice } from './bridge.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employees/employee-config.ts';
import { freezeManagedPdfBinding } from './employees/managed-pdf-binding.ts';
import { authorizeFixturePlatformAdministrator } from './platform-authority.fixture.ts';
import { createToolBrokerExportObject } from './execution/tool-broker.ts';
import {
  runtimePolicyDigest as digest,
  setRuntimePolicyControls,
} from './runtime-policy.ts';
import { updateWorkAutomation } from './work-automation.ts';
import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import {
  assertLocalPdfDelegation,
  createLocalPdfReadOperation,
  localPdfTransferAuthority,
  readBridgeOperationTransferCapability,
  readLocalPdfInput,
  readLocalPdfRuntimeGrant,
  reportLocalPdfProfile,
  selectLocalPdfExecution,
  waitLocalPdfReadOperation,
} from './local-pdf-execution.ts';
import * as client from './core/client.ts';
import { authenticateSession, createSession } from './identity.ts';
import { mutateCompanyAsset } from './company-assets.ts';
import {
  captureCompanyRunAssets,
  prepareCompanyRunMaterials,
} from './company-run-assets.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const profile = RuntimeLocalPdfProfileSchema.parse({
  contractVersion: 1,
  profileVersion: 1,
  backend: 'native-seatbelt-v1',
  platform: 'macos-x64',
  pins: {
    nodeVersion: '22.23.2',
    parserVersion: '2.4.5',
    pdfJsVersion: '5.4.296',
    canvasVersion: '0.1.80',
    resourceManifestChecksum:
      'sha256:ed7b2874d70fe5087f6b045489ab62bf812ea8dc00f06882aed5d1dde6150d68',
    policyChecksum:
      'sha256:ff68ca0be9f1c81cb0191aa401da1a334c6ebdb63272b23842addd46a0969800',
  },
  available: true,
  readOnly: true,
  ocr: false,
  stopConfirmed: true,
  isolation: {
    network: 'none',
    hostFileAccess: 'none',
    childExecution: 'none',
    memoryEnforcement: 'watchdog',
    resourceBudgetBytes: localPdfMemoryBudgetBytesV1,
    watchdogThresholdBytes: localPdfMemoryBudgetBytesV1,
    timeoutMs: localPdfTimeoutMsV1,
    deniedHostRead: true,
    deniedHostWrite: true,
    deniedNetwork: true,
    deniedChildExecution: true,
  },
  limits: {
    inputBytes: localPdfInputBytesV1,
    resultBytes: localPdfResultBytesV1,
    maximumPages: 10,
    maximumCharacters: 300000,
  },
});

suite('MET166 independent read-only PDF original-call authority', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', '1');
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '0');
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '0');
    database = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
  }, 60000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await database?.close();
  });

  // Every frozen snapshot is inserted once. Negative cases never retrofit an old Run.
  const fixture = async (
    options: {
      freezeBinding?: boolean;
      bridgeAccess?: 'read_only' | 'read_write' | 'none';
      reverseManifest?: boolean;
      deniedRead?: boolean;
      tool?: boolean;
      artifactVersion?: boolean;
      legacyMime?: boolean;
      resourceRead?: boolean;
    } = {},
  ) => {
    const db = database.db,
      org = randomUUID(),
      workspace = randomUUID(),
      owner = randomUUID(),
      admin = randomUUID(),
      membership = randomUUID(),
      runId = randomUUID(),
      jobId = randomUUID(),
      workerId = randomUUID(),
      jobLeaseToken = randomUUID(),
      policyId = randomUUID(),
      employeeId = randomUUID(),
      versionId = randomUUID(),
      assignmentId = randomUUID(),
      sessionId = randomUUID(),
      userMessageId = randomUUID(),
      assistantMessageId = randomUUID(),
      platformId = randomUUID(),
      publicationId = randomUUID(),
      deviceId = randomUUID();
    const now = new Date().toISOString(),
      memberships = [
        {
          id: membership,
          organizationId: org,
          workspaceId: workspace,
          userId: owner,
          role: 'member' as const,
          active: true,
        },
      ],
      context: RequestContext = {
        actor: { type: 'user', id: owner },
        organizationId: org,
        workspaceId: workspace,
        requestId: randomUUID(),
        sessionId: randomUUID(),
        authenticatedAt: now,
        memberships,
      };
    const candidate = employeeManifest({
      key: 'readonly-pdf',
      name: 'Synthetic PDF reader',
      description: 'Isolated read-only fixture',
      toolNames: options.tool === false ? [] : ['workspace.document.read'],
      securityPolicy: {
        dataScopes: ['workspace', 'user'],
        connectorIdentityModes: ['user'],
        approvalPolicy: 'autonomous',
        deniedCapabilities: [
          'storage:write',
          ...(options.deniedRead ? ['storage:read' as const] : []),
        ],
      },
    });
    if (candidate.schemaVersion !== 2) throw Error('V2 fixture required');
    const manifest = options.reverseManifest
        ? (Object.fromEntries(
            Object.entries(candidate).reverse(),
          ) as typeof candidate)
        : candidate,
      definitionChecksum = employeeManifestChecksum(manifest),
      publication = PlatformEmployeeDefinitionSchema.parse({
        schemaVersion: 1,
        key: `readonly-pdf-${platformId}`,
        name: manifest.name,
        description: manifest.description,
        appearance: manifest.appearance,
        identity: {
          ...manifest.identity,
          expressionStyle: 'structured',
          outputLanguage: 'zh-CN',
        },
        systemPrompt: manifest.systemPrompt,
        modelPolicy: {
          provider: 'openai-codex',
          model: 'synthetic',
          reasoningEffort: 'low',
          timeoutMs: 300000,
          fallbackModels: [],
          credentialReference: 'test:never-resolved',
          baseUrl: null,
        },
        capabilities: {
          nativeSkillIds: [],
          workflowRevisionIds: [],
          knowledgeRevisionIds: [],
          toolNames: manifest.capabilityBindings.toolNames,
          connectorRefs: [],
        },
        securityPolicy: {
          ...manifest.securityPolicy,
          bridgeAccess: options.bridgeAccess ?? 'read_only',
        },
      }),
      publicationChecksum = digest(publication);
    const managedPdf =
      options.freezeBinding === false
        ? undefined
        : freezeManagedPdfBinding({
            manifest,
            grantedCapabilities: ['storage:read'],
            publication: {
              revisionId: publicationId,
              checksum: publicationChecksum,
              definition: publication,
            },
          });
    const policyPayload = {
      memberships,
      grants: [
        { resourceType: 'job', action: 'job:execute', workspaceId: workspace },
        ...(options.resourceRead === false
          ? []
          : [
              {
                resourceType: 'storage_object',
                action: 'resource:read',
                workspaceId: workspace,
              },
            ]),
      ],
    };
    const frozen = EmployeeExecutionSnapshotSchema.parse({
      schemaVersion: 2,
      employee: {
        id: employeeId,
        versionId,
        key: manifest.key,
        revision: 1,
        definitionChecksum,
        definition: manifest,
      },
      assignment: {
        id: assignmentId,
        userId: owner,
        assignedBy: admin,
        assignedAt: now,
      },
      runtimePolicy: {
        harness: 'dsh',
        provider: 'openai-codex',
        model: 'synthetic',
        reasoningEffort: 'low',
        timeoutMs: 300000,
        fallbackModels: [],
        credentialReference: 'test:never-resolved',
      },
      capabilitySnapshot: {
        declaredCapabilities: ['storage:read'],
        grantedCapabilities: ['storage:read'],
        bindings: {
          skillVersionIds: [],
          toolNames: manifest.capabilityBindings.toolNames,
          knowledgeScopes: ['workspace'],
          workflowIds: [],
          ...(managedPdf ? { managedPdf } : {}),
        },
        skillBindings: [],
        agentSkills: [],
        workflows: [],
        knowledge: [],
        resolvedForActorId: owner,
      },
      tenantContext: {
        organizationId: org,
        workspaceId: workspace,
        actorId: owner,
        policySnapshotId: policyId,
      },
      userProfile: {
        schemaVersion: 1,
        displayName: 'Synthetic member',
        preferences: {},
      },
      createdAt: now,
    });
    if (frozen.schemaVersion !== 2) throw Error('V2 fixture required');
    await db.begin(async (tx) => {
      await tx`insert into allrice_users(id,email,display_name,password_hash) values(${owner},${`${owner}@example.test`},'Synthetic member','not-login'),(${admin},${`${admin}@example.test`},'Synthetic administrator','not-login')`;
      await tx`insert into allrice_organizations(id,slug,name) values(${org},${`pdf-${org}`},'Synthetic PDF scope')`;
      await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'test','Synthetic PDF scope')`;
      await tx`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${membership},${org},${workspace},${owner},'member'),(${randomUUID()},${org},${workspace},${admin},'admin')`;
      await tx`insert into allrice_platform_employees(id,employee_key,name,description,status) values(${platformId},${publication.key},'Synthetic PDF reader','Isolated only','published')`;
      await tx`insert into allrice_platform_employee_revisions(id,employee_id,revision,status,definition,checksum,published_at) values(${publicationId},${platformId},1,'published',${tx.json(publication)},${publicationChecksum},clock_timestamp())`;
      await tx`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at) values(${policyId},${org},${owner},1,${tx.json(policyPayload)},clock_timestamp()+interval '1 hour')`;
      await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input) values(${runId},${org},${workspace},${owner},'running',${policyId},${tx.json({ employeeVersionId: versionId })},'{}')`;
      await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employeeId},${org},${workspace},'readonly-pdf','Synthetic PDF reader')`;
      await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest) values(${versionId},${org},${workspace},${employeeId},1,'Synthetic PDF reader','synthetic','synthetic',${tx.json(['storage:read'])},${definitionChecksum},${tx.json(manifest)})`;
      await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${assignmentId},${org},${workspace},${employeeId},${versionId},${owner})`;
      await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${sessionId},${org},${workspace},${owner},'Synthetic PDF session',${assignmentId},${versionId})`;
      await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content) values(${userMessageId},${org},${workspace},${sessionId},${owner},'user','{"text":"Read the authorized synthetic PDF","citations":[]}'),(${assistantMessageId},${org},${workspace},${sessionId},${owner},'assistant','{"text":"","citations":[]}')`;
      await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,execution_snapshot,native_skills) values(${runId},${org},${workspace},${owner},${assignmentId},${versionId},${sessionId},${userMessageId},${assistantMessageId},'{}','{}',${tx.json(JSON.parse(JSON.stringify(frozen)))},'[]')`;
      await tx`insert into allrice_conversation_runtimes(organization_id,workspace_id,session_id,owner_id,thread_generation,config_checksum,state,active_run_id,worker_id) values(${org},${workspace},${sessionId},${owner},1,${definitionChecksum},'running',${runId},${workerId})`;
      await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at,attempt) values(${jobId},${org},${workspace},${owner},${runId},'running',${randomUUID()},clock_timestamp()+interval '5 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${workerId},${jobLeaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes',1)`;
    });
    const execution = ExecutionContextSchema.parse({
      executionId: randomUUID(),
      runId,
      jobId,
      worker: { type: 'worker', id: workerId },
      delegatedBy: context.actor,
      organizationId: org,
      workspaceId: workspace,
      policySnapshot: {
        id: policyId,
        organizationId: org,
        subjectId: owner,
        version: 1,
        issuedAt: now,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        ...policyPayload,
      },
      startedAt: now,
    });
    const adminContext: RequestContext = {
      ...context,
      actor: { type: 'user', id: admin },
      memberships: [
        { ...memberships[0]!, id: randomUUID(), userId: admin, role: 'admin' },
      ],
    };
    await authorizeFixturePlatformAdministrator(db, admin);
    await setRuntimePolicyControls(
      adminContext,
      {
        version: 1,
        enabled: true,
        mode: 'execute',
        rules: [
          { action: 'local.pdf.read', effect: 'allow' },
          { action: 'local.python.execute', effect: 'deny' },
          { action: 'local.process.execute', effect: 'deny' },
        ],
      },
      null,
      db,
    );
    await updateWorkAutomation(
      context,
      workspace,
      { expectedRevision: 0, capability: 'computer', enabled: true },
      db,
    );
    const bytes = await readFile(
        new URL(
          '../../../tests/fixtures/pdf/01-chinese-multipage-digital.pdf',
          import.meta.url,
        ),
      ),
      object = createToolBrokerExportObject({
        context: execution,
        mediaType: options.legacyMime
          ? 'application/octet-stream'
          : 'application/pdf',
        sizeBytes: bytes.length,
        checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      });
    await assistantFixtureStorage(db).put(
      object,
      new Blob([Uint8Array.from(bytes)]).stream(),
    );
    await db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,visibility,state) values(${object.id},${org},${workspace},${owner},${object.key},'uploads',${object.mediaType},${bytes.length},${object.checksum},'private','ready')`;
    const artifactVersionId = options.artifactVersion
        ? randomUUID()
        : undefined,
      fileName =
        options.artifactVersion || options.legacyMime
          ? 'fixed-source.pdf'
          : '未命名文件';
    if (artifactVersionId)
      await db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format)
        values(${artifactVersionId},${org},${workspace},${owner},${object.id},${randomUUID()},1,${sessionId},${fileName},'pdf')`;
    if (options.legacyMime)
      await db`insert into allrice_file_references(organization_id,workspace_id,object_id,session_id,owner_id,file_name)
        values(${org},${workspace},${object.id},${sessionId},${owner},${fileName})`;
    const token = `synthetic-pdf-${randomUUID()}`;
    await db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at) values(${deviceId},${org},${workspace},${owner},'Synthetic PDF device','macos-x64',2,array['local.pdf.read'],${createHash('sha256').update(token).digest('hex')},clock_timestamp())`;
    const device = BridgeDeviceSchema.parse({
      id: deviceId,
      organizationId: org,
      workspaceId: workspace,
      ownerId: owner,
      name: 'Synthetic PDF device',
      platform: 'macos-x64',
      protocolVersion: 2,
      capabilities: ['local.pdf.read'],
      status: 'online',
      lastSeenAt: now,
      createdAt: now,
      revokedAt: null,
    });
    const heartbeat = async (
      state: 'ready' | 'busy' | 'preparing' | 'paused' = 'ready',
    ) =>
      heartbeatBridgeDevice(token, {
        protocolVersion: 2,
        capabilities: ['local.pdf.read'],
        environment: {
          version: 1,
          clientVersion: 'synthetic-pdf',
          browser: 'unavailable',
          sandbox: 'unavailable',
          preview: 'unavailable',
          paused: state === 'paused',
          readiness: [
            {
              capability: 'local.pdf.read',
              state,
              reason: `pdf_${state}`,
              missing: [],
              versions: { parser: '2.4.5' },
              observedAt: new Date().toISOString(),
            },
          ],
        },
      });
    await heartbeat();
    await reportLocalPdfProfile(device, profile, db);
    const source = {
        objectId: object.id,
        checksum: object.checksum,
        sizeBytes: object.sizeBytes,
        mediaType: object.mediaType,
        ...(artifactVersionId ? { artifactVersionId, artifactVersion: 1 } : {}),
      },
      args = { objectId: object.id, pages: [2], includeStructure: true };
    const select = (
      callId = 'pdf-original',
      raw: Record<string, unknown> = args,
    ) =>
      selectLocalPdfExecution(
        {
          context: execution,
          callId,
          toolName: 'workspace.document.read',
          arguments: raw,
          source,
          jobAttempt: 1,
          jobLeaseToken,
        },
        db,
      );
    const payload = (
      callId = 'pdf-original',
      raw: Record<string, unknown> = args,
    ): RuntimeLocalPdfPayload =>
      RuntimeLocalPdfPayloadSchema.parse({
        capability: 'local.pdf.read',
        arguments: {
          path: '.',
          origin: {
            toolName: 'workspace.document.read',
            callId,
            argumentsDigest: digest(raw),
          },
          source,
          fileName,
          options: Object.fromEntries(
            Object.entries(raw).filter(([key]) =>
              ['pages', 'includeStructure', 'maxCharacters'].includes(key),
            ),
          ),
          profileVersion: 1,
          pins: profile.pins,
          limits: {
            inputBytes: localPdfInputBytesV1,
            resultBytes: localPdfResultBytesV1,
            timeoutMs: localPdfTimeoutMsV1,
            resourceBudgetBytes: localPdfMemoryBudgetBytesV1,
          },
        },
      });
    const create = async (
      callId = 'pdf-original',
      raw: Record<string, unknown> = args,
    ) =>
      createLocalPdfReadOperation(
        {
          selection: await select(callId, raw),
          context: execution,
          payload: payload(callId, raw),
          arguments: raw,
        },
        db,
      );
    return {
      org,
      workspace,
      owner,
      device,
      token,
      execution,
      context,
      adminContext,
      jobId,
      jobLeaseToken,
      runId,
      sessionId,
      versionId,
      publicationId,
      frozen,
      object,
      bytes,
      source,
      args,
      heartbeat,
      select,
      payload,
      create,
    };
  };

  it('resolves an authorized company PDF input without a generic file reference and refuses it after withdrawal', async () => {
    const f = await fixture({ artifactVersion: true }),
      db = database.db;
    const owner = {
      ...(await authenticateSession((await createSession(f.owner)).token))!,
      workspaceId: f.workspace,
    };
    let asset = await mutateCompanyAsset(
      owner,
      f.org,
      {
        operation: 'save',
        assetId: randomUUID(),
        expectedRevision: 0,
        content: {
          kind: 'template',
          title: 'PDF 范本',
          body: 'Use current task data.',
          category: '',
          appliesToEmployeeIds: [],
          taskKeywords: [],
          slots: [],
          sourceVersionId: f.source.artifactVersionId,
        },
      },
      assistantFixtureStorage(db),
      false,
      db,
    );
    asset = await mutateCompanyAsset(
      owner,
      f.org,
      {
        operation: 'publish',
        assetId: asset.id,
        expectedRevision: asset.revision,
      },
      assistantFixtureStorage(db),
      false,
      db,
    );
    const snapshot = await db.begin((tx) =>
      captureCompanyRunAssets(tx, owner, f.versionId, 'Read selected PDF', [
        {
          assetId: asset.id,
          revisionId: asset.latest.id,
          digest: asset.latest.digest,
          parameters: {},
        },
      ]),
    );
    // A new formal fixture Run gets its snapshot at insert; existing evidence
    // remains append-only and its immutability triggers stay enabled.
    const runId = randomUUID(),
      jobId = randomUUID(),
      question = randomUUID(),
      answer = randomUUID();
    await db.begin(async (tx) => {
      await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input)
        select ${runId},organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input from allrice_runs where id=${f.runId}`;
      await tx`insert into allrice_messages(id,organization_id,workspace_id,owner_id,session_id,role,content)
        values(${question},${f.org},${f.workspace},${f.owner},${f.sessionId},'user','{"text":"Read company PDF"}'),
        (${answer},${f.org},${f.workspace},${f.owner},${f.sessionId},'assistant','{"text":""}')`;
      await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,execution_snapshot)
        select ${runId},organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,${question},${answer},provider_snapshot,${tx.json({ companyAssets: snapshot })},execution_snapshot from allrice_employee_runs where run_id=${f.runId}`;
      await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at,attempt)
        select ${jobId},organization_id,workspace_id,owner_id,${runId},status,${randomUUID()},timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at,attempt from allrice_jobs where id=${f.jobId}`;
      await tx`update allrice_conversation_runtimes set active_run_id=${runId} where session_id=${f.sessionId}`;
    });
    const execution = { ...f.execution, runId, jobId };
    const [material] = await prepareCompanyRunMaterials(
      execution,
      snapshot,
      assistantFixtureStorage(db),
      db,
    );
    const source = {
      objectId: material!.object.id,
      checksum: material!.object.checksum,
      sizeBytes: material!.object.sizeBytes,
      mediaType: material!.object.mediaType,
    };
    expect(
      await db`select object_id from allrice_file_references where object_id=${source.objectId}`,
    ).toHaveLength(0);
    const raw = { ...f.args, objectId: source.objectId },
      callId = 'company-pdf';
    const select = () =>
      selectLocalPdfExecution(
        {
          context: execution,
          callId,
          toolName: 'workspace.document.read',
          arguments: raw,
          source,
          jobAttempt: 1,
          jobLeaseToken: f.jobLeaseToken,
        },
        db,
      );
    const selected = await select();
    expect(selected.fileName).toBe('fixed-source.pdf');
    const originalPayload = f.payload(callId, raw);
    const payload = RuntimeLocalPdfPayloadSchema.parse({
      ...originalPayload,
      arguments: {
        ...originalPayload.arguments,
        source,
        fileName: selected.fileName,
      },
    });
    const created = await createLocalPdfReadOperation(
      { selection: selected, context: execution, payload, arguments: raw },
      db,
    );
    const [operation] = await db`
      select bridge_payload from allrice_runtime_operations
      where id = ${created.snapshot.binding.attempt.operationId}
    `;
    expect(operation!.bridge_payload.arguments.fileName).toBe(
      'fixed-source.pdf',
    );
    await mutateCompanyAsset(
      owner,
      f.org,
      {
        operation: 'withdraw',
        assetId: asset.id,
        expectedRevision: asset.revision,
      },
      assistantFixtureStorage(db),
      false,
      db,
    );
    await expect(select()).rejects.toThrow('asset_unavailable');
  });

  const running = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const created = await f.create(),
      lease = await created.ledger.claimNextBridgeOperation({
        scope: created.snapshot.binding.task.scope,
        deviceId: f.device.id,
        leaseMs: 120000,
        supportsPdfRead: true,
      });
    expect(lease).not.toBeNull();
    const identity = {
      scope: created.snapshot.binding.task.scope,
      operationId: created.snapshot.binding.attempt.operationId,
      leaseToken: lease!.leaseToken,
      attempt: created.snapshot.binding.attempt,
    };
    await created.ledger.recordReceipt({
      ...identity,
      receiptId: randomUUID(),
      signal: { type: 'operation.started', processId: randomUUID() },
    });
    return { created, identity };
  };
  const result = (p: RuntimeLocalPdfPayload) =>
    RuntimeLocalPdfResultSchema.parse({
      type: 'local_pdf_read_result_v1',
      origin: p.arguments.origin,
      source: p.arguments.source,
      profileVersion: 1,
      pins: p.arguments.pins,
      document: {
        kind: 'pdf',
        text: '第2页：实际原字符串',
        truncated: false,
        units: [{ label: '第2页', text: '第2页：实际原字符串', pageNumber: 2 }],
        warnings: [],
        totalPages: 3,
        requestedPages: [2],
        nextPages: [3],
        quality: 'digital_text',
        warningCodes: [],
        parser: { name: 'pdf-parse', version: '2.4.5' },
        tables: [],
      },
      error: null,
      process: {
        stopped: true,
        exitCode: 0,
        reason: 'completed',
        memoryEnforcement: 'watchdog',
        observedPeakRssBytes: 32000000,
      },
    });

  it('ordinary read_only member executes and reads exact bytes without Node, Python, folder or write grants', async () => {
    const f = await fixture(),
      db = database.db;
    expect(f.frozen.capabilitySnapshot.grantedCapabilities).toEqual([
      'storage:read',
    ]);
    expect(f.frozen.capabilitySnapshot.bindings.managedPython).toBeUndefined();
    expect(f.context.memberships[0]!.role).toBe('member');
    expect((await f.select()).choice).toMatchObject({
      location: 'local',
      status: 'execute',
      reason: 'local_ready',
    });
    const { created, identity } = await running(f);
    expect(
      await readBridgeOperationTransferCapability(
        f.token,
        identity.operationId,
        identity.leaseToken,
        db,
      ),
    ).toBe('local.pdf.read');
    const input = await readLocalPdfInput(
      f.token,
      identity.operationId,
      identity.leaseToken,
      f.object.id,
      db,
    );
    expect(input.object.checksum).toBe(f.object.checksum);
    const stored = await assistantFixtureStorage(db).get(input.object);
    expect(Buffer.from(await new Response(stored).arrayBuffer())).toEqual(
      f.bytes,
    );
    const proof = result(f.payload()),
      receipt = {
        ...identity,
        receiptId: randomUUID(),
        signal: {
          type: 'operation.outcome' as const,
          result: {
            status: 'succeeded' as const,
            effects: 'none' as const,
            evidence: {
              id: randomUUID(),
              recordedAt: new Date().toISOString(),
              digest: digest(proof),
            },
          },
        },
        evidence: { output: proof },
      };
    const accepted = await created.ledger.recordReceipt(receipt);
    expect(accepted.disposition).toBe('applied');
    expect(accepted.snapshot.status).toBe('succeeded');
    expect((await created.ledger.recordReceipt(receipt)).disposition).toBe(
      'duplicate',
    );
    expect(
      (await waitLocalPdfReadOperation(created, undefined, db)).evidence,
    ).toEqual({ output: proof });
    const [counts] =
      await db`select (select count(*)::int from allrice_bridge_managed_runtime_grants where device_id=${f.device.id}) as python,
      (select count(*)::int from allrice_bridge_folder_grants where device_id=${f.device.id}) as folders`;
    expect(counts).toEqual({ python: 0, folders: 0 });
  });

  it('legacy/default and false support claims cannot consume a PDF operation', async () => {
    const f = await fixture(),
      created = await f.create(),
      base = {
        scope: created.snapshot.binding.task.scope,
        deviceId: f.device.id,
        leaseMs: 120000,
      };
    expect(await created.ledger.claimNextBridgeOperation(base)).toBeNull();
    expect(
      await created.ledger.claimNextBridgeOperation({
        ...base,
        supportsPdfRead: false,
        supportsManagedPython: true,
      }),
    ).toBeNull();
    expect(
      await created.ledger.claimNextBridgeOperation({
        ...base,
        supportsPdfRead: true,
      }),
    ).not.toBeNull();
  });

  it('does not add raw defaults and rejects an altered call under the same stable identity', async () => {
    const f = await fixture(),
      raw = { objectId: f.object.id },
      created = await f.create('no-defaults', raw);
    const [origin] =
      await database.db`select original_arguments from allrice_local_pdf_delegations where operation_id=${created.snapshot.binding.attempt.operationId}`;
    expect(origin!.original_arguments).toEqual(raw);
    await expect(
      f.select('no-defaults', { ...raw, includeStructure: false }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      database.db`update allrice_local_pdf_delegations set original_arguments='{}' where operation_id=${created.snapshot.binding.attempt.operationId}`,
    ).rejects.toThrow('immutable read-only PDF origin');
  });

  it.each([{ artifactVersion: true }, { legacyMime: true }])(
    'keeps actual artifact versions and legacy PDF MIME/name admission (%j)',
    async (options) => {
      const f = await fixture(options),
        { created, identity } = await running(f);
      const file = await readLocalPdfInput(
        f.token,
        identity.operationId,
        identity.leaseToken,
        f.object.id,
        database.db,
      );
      expect(file.object.checksum).toBe(f.object.checksum);
      expect(file.fileName).toBe('fixed-source.pdf');
      expect(created.snapshot.binding.action).toBe('local.pdf.read');
      await expect(
        database.db.begin((tx) =>
          assertLocalPdfDelegation(
            tx,
            f.device,
            created.snapshot.binding,
            f.payload(),
            f.frozen,
          ),
        ),
      ).resolves.toBeUndefined();
    },
  );

  it.each([{ freezeBinding: false }, { bridgeAccess: 'none' as const }])(
    'keeps historical/missing bindings cloud-only; explicit local is unavailable (%j)',
    async (options) => {
      const f = await fixture(options);
      expect((await f.select('auto')).choice).toMatchObject({
        location: 'cloud',
        status: 'execute',
      });
      expect(
        (await f.select('explicit', { ...f.args, location: 'local' })).choice,
      ).toMatchObject({ location: 'local', status: 'unavailable' });
    },
  );
  it.each([{ deniedRead: true }, { tool: false }])(
    'rejects original frozen read denial (%j)',
    async (options) => {
      const f = await fixture(options);
      await expect(f.select()).rejects.toMatchObject({
        code: 'frozen_configuration_invalid',
      });
    },
  );
  it('requires the original execution policy storage read grant even when the employee declares read', async () => {
    const f = await fixture({ resourceRead: false });
    await expect(f.select()).rejects.toMatchObject({
      code: 'bridge_authority_changed',
    });
  });

  it.each(['busy', 'preparing'] as const)(
    'keeps %s local as durable wait with no operation/cloud slot',
    async (state) => {
      const f = await fixture();
      await f.heartbeat(state);
      const selected = await f.select();
      expect(selected.choice).toMatchObject({
        location: 'local',
        status: 'wait',
        reason: `local_${state}`,
      });
      await expect(f.create()).rejects.toMatchObject({
        code: state === 'busy' ? 'local_runner_busy' : 'local_runner_preparing',
      });
      const [counts] =
        await database.db`select (select count(*)::int from allrice_runtime_operations where run_id=${f.runId}) as operations,(select count(*)::int from allrice_runtime_operations where run_id=${f.runId} and snapshot->'binding'->'execution'->>'targetKind'='cloud_sandbox') as cloud`;
      expect(counts).toEqual({ operations: 0, cloud: 0 });
    },
  );

  it('honors explicit cloud, local-only text, paused devices and stale profile without granting more rights', async () => {
    const f = await fixture();
    expect(
      (await f.select('cloud', { ...f.args, location: 'cloud' })).choice,
    ).toMatchObject({ location: 'cloud', reason: 'explicit_cloud' });
    await f.heartbeat('paused');
    expect((await f.select('paused')).choice).toMatchObject({
      location: 'cloud',
      reason: 'local_paused',
    });
    await f.heartbeat();
    await database.db`update allrice_bridge_pdf_profiles set reported_at=clock_timestamp()-interval '91 seconds' where device_id=${f.device.id}`;
    expect((await f.select('stale')).choice).toMatchObject({
      location: 'cloud',
      reason: 'local_unsupported',
    });
    await database.db`update allrice_messages set content='{"text":"local-only do not upload","citations":[]}' where id=(select user_message_id from allrice_employee_runs where run_id=${f.runId})`;
    expect((await f.select('local-only')).choice).toMatchObject({
      location: 'local',
      status: 'unavailable',
      reason: 'local_inputs_required',
    });
  });

  it('rejects invented release pins and profile proof, without issuing a runtime grant', async () => {
    const f = await fixture();
    await expect(
      reportLocalPdfProfile(
        f.device,
        {
          ...profile,
          pins: { ...profile.pins, policyChecksum: `sha256:${'f'.repeat(64)}` },
        },
        database.db,
      ),
    ).rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(
      reportLocalPdfProfile(
        f.device,
        {
          ...profile,
          isolation: { ...profile.isolation, deniedNetwork: false },
        },
        database.db,
      ),
    ).rejects.toThrow();
    await database.db`update allrice_bridge_pdf_runtime_grants set revoked_at=clock_timestamp() where device_id=${f.device.id}`;
    expect((await f.select()).choice).toMatchObject({
      location: 'cloud',
      reason: 'local_unsupported',
    });
  });

  it('preserves the original published checksum across JSONB key order and rejects a tampered manifest', async () => {
    const f = await fixture({ reverseManifest: true }),
      created = await f.create();
    await expect(
      database.db.begin((tx) =>
        assertLocalPdfDelegation(
          tx,
          f.device,
          created.snapshot.binding,
          f.payload(),
          f.frozen,
        ),
      ),
    ).resolves.toBeUndefined();
    const bad = EmployeeExecutionSnapshotSchema.parse({
      ...f.frozen,
      employee: {
        ...f.frozen.employee,
        definition: { ...f.frozen.employee.definition, name: 'Tampered name' },
      },
    });
    await expect(
      database.db.begin((tx) =>
        assertLocalPdfDelegation(
          tx,
          f.device,
          created.snapshot.binding,
          f.payload(),
          bad,
        ),
      ),
    ).rejects.toMatchObject({ code: 'bridge_authority_changed' });
  });

  it.each(['wrong-object', 'wrong-lease', 'upload'] as const)(
    'refuses %s at the original operation transfer',
    async (mode) => {
      const f = await fixture(),
        { identity } = await running(f);
      await expect(
        localPdfTransferAuthority(
          f.token,
          identity.operationId,
          mode === 'wrong-lease' ? randomUUID() : identity.leaseToken,
          mode === 'wrong-object' ? randomUUID() : f.object.id,
          mode === 'upload' ? ('upload' as 'download') : 'download',
          database.db,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    },
  );

  it('binds device owner/workspace, actual version and revoked source before download', async () => {
    const f = await fixture(),
      other = await fixture(),
      { identity } = await running(f);
    await expect(
      readBridgeOperationTransferCapability(
        other.token,
        identity.operationId,
        identity.leaseToken,
        database.db,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      selectLocalPdfExecution(
        {
          context: f.execution,
          callId: 'foreign',
          toolName: 'workspace.document.read',
          arguments: { objectId: other.object.id },
          source: other.source,
          jobAttempt: 1,
          jobLeaseToken: f.jobLeaseToken,
        },
        database.db,
      ),
    ).rejects.toMatchObject({ code: 'bridge_authority_changed' });
    await expect(
      selectLocalPdfExecution(
        {
          context: f.execution,
          callId: 'fake-version',
          toolName: 'workspace.document.read',
          arguments: f.args,
          source: {
            ...f.source,
            artifactVersionId: randomUUID(),
            artifactVersion: 1,
          },
          jobAttempt: 1,
          jobLeaseToken: f.jobLeaseToken,
        },
        database.db,
      ),
    ).rejects.toMatchObject({ code: 'bridge_authority_changed' });
    await database.db`update allrice_storage_objects set state='deleted',deleted_at=clock_timestamp() where id=${f.object.id}`;
    await expect(
      readLocalPdfInput(
        f.token,
        identity.operationId,
        identity.leaseToken,
        f.object.id,
        database.db,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });

  it.each([
    'attempt',
    'lease',
    'membership',
    'device',
    'thread',
    'run',
    'profile',
    'runtime-grant',
    'worker',
    'lease-expired',
    'job-cancel',
  ] as const)('rechecks %s drift at dispatch/transfer', async (change) => {
    const f = await fixture(),
      created = await f.create(),
      db = database.db;
    if (change === 'attempt')
      await db`update allrice_jobs set attempt=attempt+1 where id=${f.jobId}`;
    if (change === 'lease')
      await db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.jobId}`;
    if (change === 'membership')
      await db`update allrice_memberships set active=false where user_id=${f.owner}`;
    if (change === 'device')
      await db`update allrice_bridge_devices set revoked_at=clock_timestamp() where id=${f.device.id}`;
    if (change === 'thread')
      await db`update allrice_conversation_runtimes set thread_generation=thread_generation+1 where session_id=${f.sessionId}`;
    if (change === 'run')
      await db`update allrice_runs set state='canceled' where id=${f.runId}`;
    if (change === 'profile')
      await db`update allrice_bridge_pdf_profiles set reported_at=clock_timestamp()-interval '91 seconds' where device_id=${f.device.id}`;
    if (change === 'runtime-grant')
      await db`update allrice_bridge_pdf_runtime_grants set revoked_at=clock_timestamp(),runtime_generation=runtime_generation+1 where device_id=${f.device.id}`;
    if (change === 'worker')
      await db`update allrice_jobs set worker_id=${randomUUID()} where id=${f.jobId}`;
    if (change === 'lease-expired')
      await db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.jobId}`;
    if (change === 'job-cancel')
      await db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${f.jobId}`;
    const ledger = createGovernedBridgeOperationLedger(f.device, {
      database: db,
    });
    expect(
      await ledger.claimNextBridgeOperation({
        scope: created.snapshot.binding.task.scope,
        deviceId: f.device.id,
        leaseMs: 120000,
        supportsPdfRead: true,
      }),
    ).toBeNull();
    if (change === 'device')
      expect(
        (await readLocalPdfRuntimeGrant(f.device, db))!.revokedAt,
      ).not.toBeNull();
  });

  it('does not accept an unbound or not-stopped successful result', async () => {
    const f = await fixture(),
      { created, identity } = await running(f),
      proof = result(f.payload());
    for (const output of [
      {
        ...proof,
        source: { ...proof.source, checksum: `sha256:${'f'.repeat(64)}` },
      },
      { ...proof, process: { ...proof.process, stopped: false } },
      { ...proof, document: { ...proof.document!, requestedPages: [1] } },
      {
        ...proof,
        origin: {
          ...proof.origin,
          argumentsDigest: `sha256:${'a'.repeat(64)}`,
        },
      },
    ])
      await expect(
        created.ledger.recordReceipt({
          ...identity,
          receiptId: randomUUID(),
          signal: {
            type: 'operation.outcome',
            result: {
              status: 'succeeded',
              effects: 'none',
              evidence: {
                id: randomUUID(),
                recordedAt: new Date().toISOString(),
                digest: digest(output),
              },
            },
          },
          evidence: { output },
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('unknown remains bound to its original operation and cannot fallback or create another parse', async () => {
    const f = await fixture(),
      { created, identity } = await running(f);
    await created.ledger.recordReceipt({
      ...identity,
      receiptId: randomUUID(),
      signal: {
        type: 'operation.uncertain',
        reason: 'connection_lost',
      },
    });
    const selected = await f.select();
    expect(selected.choice).toEqual({
      location: 'local',
      status: 'reconcile',
      reason: 'outcome_unknown',
    });
    await expect(f.create()).rejects.toMatchObject({
      code: 'local_pdf_outcome_unknown',
    });
    expect(
      (await waitLocalPdfReadOperation(created, undefined, database.db)).status,
    ).toBe('unknown');
    const [count] =
      await database.db`select count(*)::int as count from allrice_runtime_operations where run_id=${f.runId}`;
    expect(count!.count).toBe(1);
  });

  it('accepts an explicit pre-execution denial but never treats an unknown process or absent stop proof as terminal', async () => {
    const f = await fixture(),
      { created, identity } = await running(f);
    const failed = (output: unknown) =>
      created.ledger.recordReceipt({
        ...identity,
        receiptId: randomUUID(),
        signal: {
          type: 'operation.outcome',
          result: {
            status: 'failed',
            effects: 'none',
            evidence: {
              id: randomUUID(),
              recordedAt: new Date().toISOString(),
              digest: digest(output),
            },
          },
        },
        evidence: { output },
      });
    await expect(
      failed({ errorCode: 'UNCLASSIFIED_PROCESS_FAILURE' }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(
      failed({ errorCode: 'PDF_ATTEMPT_EXISTS' }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    const proof = RuntimeLocalPdfResultSchema.parse({
      ...result(f.payload()),
      document: null,
      error: { code: 'PDF_UNKNOWN', message: 'Stop is not confirmed' },
      process: {
        stopped: false,
        exitCode: null,
        reason: 'process_unknown',
        memoryEnforcement: 'watchdog',
        observedPeakRssBytes: 1,
      },
    });
    await expect(failed(proof)).rejects.toMatchObject({
      code: 'invalid_state',
    });
    await expect(
      failed({ ...proof, process: { ...proof.process, stopped: true } }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    await created.ledger.cancelRoot(identity.scope, f.runId, randomUUID());
    await expect(
      created.ledger.recordReceipt({
        ...identity,
        receiptId: randomUUID(),
        signal: {
          type: 'operation.stopped',
          effects: 'none',
          evidence: {
            id: randomUUID(),
            recordedAt: new Date().toISOString(),
            digest: digest({}),
          },
        },
        evidence: { output: { errorCode: 'PDF_EXECUTION_REVOKED' } },
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    const before = await fixture(),
      operation = await before.create(),
      lease = await operation.ledger.claimNextBridgeOperation({
        scope: operation.snapshot.binding.task.scope,
        deviceId: before.device.id,
        leaseMs: 120000,
        supportsPdfRead: true,
      });
    expect(lease).not.toBeNull();
    const rejected = await operation.ledger.recordReceipt({
      scope: operation.snapshot.binding.task.scope,
      operationId: operation.snapshot.binding.attempt.operationId,
      leaseToken: lease!.leaseToken,
      attempt: operation.snapshot.binding.attempt,
      receiptId: randomUUID(),
      signal: {
        type: 'operation.outcome',
        result: {
          status: 'failed',
          effects: 'none',
          evidence: {
            id: randomUUID(),
            recordedAt: new Date().toISOString(),
            digest: digest({ errorCode: 'PDF_SOURCE_CHANGED' }),
          },
        },
      },
      evidence: { output: { errorCode: 'PDF_SOURCE_CHANGED' } },
    });
    expect(rejected.snapshot.status).toBe('failed');
  });

  it('physically stopped cancel receipt settles only its original attempt without a document or applied effects', async () => {
    const f = await fixture(),
      { created, identity } = await running(f),
      p = f.payload(),
      proof = RuntimeLocalPdfResultSchema.parse({
        ...result(p),
        document: null,
        error: { code: 'PDF_CANCELED', message: 'Canceled' },
        process: {
          stopped: true,
          exitCode: null,
          reason: 'canceled',
          memoryEnforcement: 'watchdog',
          observedPeakRssBytes: 10000000,
        },
      });
    const stopped = await created.ledger.recordReceipt({
      ...identity,
      receiptId: randomUUID(),
      signal: {
        type: 'operation.stopped',
        effects: 'none',
        evidence: {
          id: randomUUID(),
          recordedAt: new Date().toISOString(),
          digest: digest(proof),
        },
      },
      evidence: { output: proof },
    });
    expect(stopped.snapshot.status).toBe('canceled');
    await expect(
      readLocalPdfInput(
        f.token,
        identity.operationId,
        identity.leaseToken,
        f.object.id,
        database.db,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
});
