import { randomUUID, createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
  StaticBrowserReferenceSchema,
  StaticBrowserTargetSchema,
  StaticBrowserDocumentSchema,
  BrowserVerificationPlanSchema,
  BrowserProfileSchema,
  staticBrowserDocumentUrl,
  type StaticBrowserTarget,
  type StaticBrowserDocument,
  type ExecutionContext,
  type BrowserVerificationPlan,
  type BridgeDevice,
  type StoragePort,
  BrowserVerificationOutcomeSchema,
  browserVerificationMatchesPlan,
  runtimeContractEqual,
  staticBrowserImageV1,
  StorageObjectSchema,
  browserOriginAllowed,
  type BrowserVerificationOutcome,
  runtimePolicyActionDecision,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  browserPrincipal,
  requestBrowserControl,
  browserStopConfirmed,
} from './browser-control.ts';
import {
  browserIdentity,
  browserControlEnabled,
  currentBrowserWorkspace,
  type BrowserWorkspaceRow,
} from './browser-control-authority.ts';
import {
  getWorkbenchArtifact,
  readArtifactBytes,
  assertPublishingRun,
  publishWorkbenchArtifact,
  type WorkbenchPrincipal,
} from './artifact-review.ts';
import {
  lockLocalBrowserController,
  type LocalControllerIdentity,
} from './local-browser-workspaces.ts';
import { cloudStableId } from './cloud-execution.ts';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
  readRuntimePolicyControls,
  type RuntimePolicyPrincipal,
} from './runtime-policy.ts';
import { readWorkAutomation } from './work-automation.ts';

type DB = ReturnType<typeof getDatabase>;
export type StaticBrowserVerificationRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  run_id: string;
  session_id: string;
  job_id: string;
  worker_id: string;
  job_attempt: number;
  job_lease_token: string;
  call_id: string;
  request_digest: string;
  target: StaticBrowserTarget;
  plan: BrowserVerificationPlan;
  execution_context: ExecutionContext;
  location: 'local' | 'cloud';
  execution_reason: string;
  device_id: string | null;
  browser_workspace_id: string | null;
  target_id: string;
  parent_grant_id: string;
  parent_grant_version: number;
  attempt_id: string;
  container_id: string | null;
  state: 'admitted' | 'running' | 'completed' | 'unknown';
  deadline_at: Date;
  browser_version: string | null;
  outcome: unknown;
  report_version_id: string | null;
  screenshot_version_id: string | null;
};

/** Both the source session and version are authorized before returning bytes.
 * Old exact versions remain usable; a stale version is never silently replaced. */
export async function resolveStaticBrowserDocument(
  context: ExecutionContext,
  reference: unknown,
  storage: StoragePort,
  db: DB = getDatabase(),
): Promise<StaticBrowserDocument> {
  const ref = StaticBrowserReferenceSchema.parse(reference),
    ctx = browserPrincipal(context);
  const [source] = await db<
    { session_id: string }[]
  >`select session_id from allrice_deliverable_versions
    where id=${ref.versionId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId}
      and owner_id=${ctx.actor.id} and session_id is not null`;
  if (!source) throw new RuntimePolicyError('static_browser_source_denied');
  const artifact = await getWorkbenchArtifact(
    ctx,
    source.session_id,
    ref.versionId,
    db,
  );
  if (
    artifact.object.checksum !== ref.checksum ||
    artifact.object.mediaType !== 'text/html' ||
    !artifact.object.immutable
  )
    throw new RuntimePolicyError('static_browser_source_changed');
  const target = StaticBrowserTargetSchema.parse({
    ...ref,
    version: 1,
    objectId: artifact.object.id,
    sizeBytes: artifact.object.sizeBytes,
    mediaType: 'text/html',
    fileName: artifact.version.fileName,
    sourceOperationId: artifact.provenance.operationId,
    sourceSessionId: source.session_id,
  });
  const bytes = await readArtifactBytes(storage, artifact.object, 100_000);
  return StaticBrowserDocumentSchema.parse({
    target,
    contentBase64: bytes.toString('base64'),
  });
}

export async function startStaticBrowserVerification(
  row: StaticBrowserVerificationRow,
  db: DB = getDatabase(),
) {
  return db.begin(async (tx) => {
    await currentStaticBrowserVerification(tx, row.execution_context, row.id);
    const started =
      await tx`update allrice_static_browser_verifications set state='running',started_at=clock_timestamp()
      where id=${row.id} and state='admitted' returning id`;
    return started.length === 1;
  });
}

export async function staticBrowserLease(
  row: StaticBrowserVerificationRow,
  db: DB = getDatabase(),
) {
  await db.begin((tx) =>
    currentStaticBrowserVerification(tx, row.execution_context, row.id),
  );
}

export async function recordStaticBrowserContainer(
  row: StaticBrowserVerificationRow,
  containerId: string,
  db: DB = getDatabase(),
) {
  if (!/^[a-f0-9]{64}$/.test(containerId))
    throw new RuntimePolicyError('static_browser_container_invalid');
  await db.begin(async (tx) => {
    await currentStaticBrowserVerification(tx, row.execution_context, row.id);
    const changed =
      await tx`update allrice_static_browser_verifications set container_id=${containerId}
      where id=${row.id} and state='running' and (container_id is null or container_id=${containerId}) returning id`;
    if (!changed.length)
      throw new RuntimePolicyError('static_browser_container_changed');
  });
}

export async function readLocalStaticBrowserCapture(
  row: StaticBrowserVerificationRow,
  storage: StoragePort,
  db: DB = getDatabase(),
) {
  const found = await db.begin(async (tx) => {
    await currentStaticBrowserVerification(tx, row.execution_context, row.id);
    const [capture] = await tx<
      {
        object: unknown;
        browser_version: string | null;
        observation: unknown;
      }[]
    >`
      select json_build_object('id',o.id,'organizationId',o.organization_id,'workspaceId',o.workspace_id,'ownerId',o.owner_id,
        'key',o.object_key,'checksum',o.checksum,'mediaType',o.media_type,'sizeBytes',o.size_bytes,
        'retentionUntil',o.retention_until,'immutable',o.immutable,'deletedAt',o.deleted_at) as object,
        v.browser_version,w.observation
      from allrice_static_browser_verifications v join allrice_browser_workspaces w on w.id=v.browser_workspace_id
      join allrice_local_browser_captures c on c.browser_workspace_id=w.id and c.organization_id=w.organization_id
        and c.workspace_id=w.workspace_id and c.kind='screenshot' and c.observation_id::text=w.observation->>'id'
      join allrice_storage_objects o on o.id=c.object_id and o.organization_id=v.organization_id and o.workspace_id=v.workspace_id and o.owner_id=v.owner_id
      where v.id=${row.id} and v.location='local' and w.state='closed' and w.stopped_at is not null
        and o.media_type='image/png' and o.deleted_at is null`;
    // device_id lives in the local workspace table; BrowserWorkspace has no stored device column.
    if (!capture || !capture.browser_version)
      throw new RuntimePolicyError('static_browser_stop_unconfirmed');
    return capture;
  });
  const object = StorageObjectSchema.parse(found.object),
    bytes = await readArtifactBytes(storage, object, 5_000_000);
  await staticBrowserLease(row, db);
  return {
    object,
    bytes,
    browserVersion: found.browser_version!,
    observation: found.observation,
  };
}

/** Only server-side, physically stopped backends call this port. A tool/model
 * cannot submit a report or bytes. Publication rechecks the exact job lease. */
export async function recordStaticBrowserOutcome(
  row: StaticBrowserVerificationRow,
  value: BrowserVerificationOutcome,
  db: DB = getDatabase(),
) {
  const outcome = BrowserVerificationOutcomeSchema.parse(value);
  if (
    outcome.verificationId !== row.id ||
    outcome.location !== row.location ||
    outcome.deviceId !== row.device_id ||
    outcome.targetId !== row.target_id ||
    outcome.attemptId !== row.attempt_id ||
    outcome.executionReason !== row.execution_reason ||
    !runtimeContractEqual(outcome.plan, row.plan) ||
    !runtimeContractEqual(outcome.report.target, row.target) ||
    !browserVerificationMatchesPlan(outcome.report, row.plan) ||
    outcome.report.planDigest !== digest(row.plan)
  )
    throw new RuntimePolicyError('static_browser_result_changed');
  await db.begin(async (tx) => {
    const current = await currentStaticBrowserVerification(
      tx,
      row.execution_context,
      row.id,
    );
    if (
      row.location === 'cloud' &&
      (current.container_id !== outcome.containerId ||
        outcome.imageDigest !== staticBrowserImageV1)
    )
      throw new RuntimePolicyError('static_browser_result_changed');
    if (row.location === 'local') {
      const [w] =
        await tx`select id from allrice_browser_workspaces where id=${row.browser_workspace_id}
        and state='closed' and stopped_at is not null and observation->>'screenshotObjectId'=${outcome.screenshotObjectId}
        and observation->>'id'=${outcome.screenshotObservationId}`;
      if (!w || current.browser_version !== outcome.browserVersion)
        throw new RuntimePolicyError('static_browser_stop_unconfirmed');
    }
    if (current.outcome && digest(current.outcome) !== digest(outcome))
      throw new RuntimePolicyError('idempotency_conflict');
    await tx`update allrice_static_browser_verifications set outcome=${tx.json(outcome)} where id=${row.id} and state='running'`;
  });
}

export async function publishStaticBrowserVerification(
  row: StaticBrowserVerificationRow,
  screenshot: Buffer,
  storage: StoragePort,
  db: DB = getDatabase(),
) {
  const current = await db.begin((tx) =>
    currentStaticBrowserVerification(tx, row.execution_context, row.id),
  );
  const outcome = BrowserVerificationOutcomeSchema.parse(current.outcome);
  if (
    `sha256:${createHash('sha256').update(screenshot).digest('hex')}` !==
    outcome.screenshotChecksum
  )
    throw new RuntimePolicyError('static_browser_capture_changed');
  const execution = {
    targetId: row.target_id,
    targetKind:
      row.location === 'local'
        ? ('rice_bridge' as const)
        : ('cloud_sandbox' as const),
    deviceId: row.device_id,
    grantId: row.parent_grant_id,
    grantVersion: row.parent_grant_version,
    scopeDigest: digest(row.target),
    workCopy: {
      id: row.id,
      kind:
        row.location === 'local'
          ? ('local_copy' as const)
          : ('cloud_copy' as const),
    },
  };
  const trusted = {
    requiredTool: 'browser.workspace' as const,
    runId: row.run_id,
    browserVerification: { execution },
    admit: async (tx: postgres.TransactionSql) => {
      const v = await currentStaticBrowserVerification(
        tx,
        row.execution_context,
        row.id,
      );
      if (digest(v.outcome) !== digest(outcome))
        throw new RuntimePolicyError('static_browser_result_changed');
    },
  };
  const image = await publishWorkbenchArtifact(
    {
      context: row.execution_context,
      sessionId: row.session_id,
      callId: `static-browser:${row.id}:png`,
      kind: 'document',
      fileName: 'browser-verification.png',
      format: 'png',
      mediaType: 'image/png',
      bytes: screenshot,
    },
    storage,
    db,
    trusted,
  );
  const label = { passed: '通过', failed: '未通过', unknown: '未能确认' }[
    outcome.report.verdict
  ];
  const text = [
    '# 页面验证：' + label,
    '',
    `来源：${row.target.fileName} · 版本 ${row.target.versionId}`,
    `内容校验：${row.target.checksum}`,
    '',
    `执行位置：${row.location === 'local' ? '我的电脑' : '云端隔离环境'} · 浏览器 ${outcome.browserVersion}`,
    '浏览器已确认停止。此验证只读取已保存的页面，没有重新构建项目。',
    '',
    ...outcome.report.steps.map(
      (s) =>
        `${s.index + 1}. ${s.type}：${s.status}${s.expected === null ? '' : `；期望 ${JSON.stringify(s.expected)}；实际 ${JSON.stringify(s.actual)}`}`,
    ),
    '',
    `[下载验证截图](/api/v1/files/${image.object.id}/download?name=browser-verification.png)`,
    `计划校验：${outcome.report.planDigest}`,
    `验证记录：${row.id}`,
    '',
    ...(outcome.report.errorCode ? ['原因：' + outcome.report.errorCode] : []),
  ].join('\n');
  const report = await publishWorkbenchArtifact(
    {
      context: row.execution_context,
      sessionId: row.session_id,
      callId: `static-browser:${row.id}:report`,
      kind: 'document',
      fileName: 'browser-verification.md',
      format: 'text',
      mediaType: 'text/markdown',
      bytes: Buffer.from(text),
    },
    storage,
    db,
    trusted,
  );
  await db.begin(async (tx) => {
    await trusted.admit(tx);
    await tx`update allrice_static_browser_verifications set state='completed',report_version_id=${report.id},screenshot_version_id=${image.id},completed_at=clock_timestamp()
      where id=${row.id} and state='running'`;
  });
  return { outcome, report, screenshot: image };
}

export async function readArtifactBrowserVerification(
  context: WorkbenchPrincipal,
  sessionId: string,
  artifactId: string,
  db: DB = getDatabase(),
) {
  await getWorkbenchArtifact(context, sessionId, artifactId, db);
  const [v] = await db<
    {
      outcome: unknown;
      report_version_id: string;
      screenshot_version_id: string;
    }[]
  >`
    select outcome,report_version_id,screenshot_version_id from allrice_static_browser_verifications
    where organization_id=${context.organizationId} and workspace_id=${context.workspaceId!} and owner_id=${context.actor.id}
      and session_id=${sessionId} and state='completed' and (report_version_id=${artifactId} or screenshot_version_id=${artifactId})`;
  return v
    ? {
        outcome: BrowserVerificationOutcomeSchema.parse(v.outcome),
        reportArtifactId: v.report_version_id,
        screenshotArtifactId: v.screenshot_version_id,
      }
    : null;
}

export async function currentStaticBrowserVerification(
  tx: postgres.TransactionSql,
  context: ExecutionContext,
  id: string,
) {
  const ctx = browserPrincipal(context);
  if (!browserControlEnabled())
    throw new RuntimePolicyError('browser_control_disabled');
  await browserIdentity(tx, ctx);
  const [intent] = await tx<
    { run_id: string; job_id: string; location: 'local' | 'cloud' }[]
  >`
    select run_id,job_id,location from allrice_static_browser_verifications where id=${id}
      and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and owner_id=${ctx.actor.id}`;
  if (!intent) throw new RuntimePolicyError('static_browser_authority_lost');
  await lockStaticBrowserPolicy(tx, ctx, intent.run_id, intent.job_id);
  await tx`select j.id from allrice_jobs j join allrice_static_browser_verifications v on v.job_id=j.id
    where v.id=${id} and v.organization_id=${ctx.organizationId} and v.workspace_id=${ctx.workspaceId}
      and v.owner_id=${ctx.actor.id} for share of j`;
  // Preserve the shared controls-before-browser lock order. Local mutations
  // retain their exact ledger approvals; the isolated cloud verifier has no
  // approval port and must require the member's current automation setting.
  const controls = await readRuntimePolicyControls(tx, ctx);
  const automation =
    intent.location === 'cloud'
      ? await readWorkAutomation(tx, {
          organizationId: ctx.organizationId,
          workspaceId: ctx.workspaceId!,
          userId: ctx.actor.id,
        })
      : undefined;
  // Every plan navigates before observing, including assertion-only plans.
  const actions = [
    `${intent.location}.browser.observe`,
    `${intent.location}.browser.act`,
  ];
  for (const action of actions) {
    const decision = runtimePolicyActionDecision(
      controls,
      action,
      [],
      automation?.settings,
    );
    if (
      decision.effect === 'deny' ||
      (intent.location === 'cloud' && decision.effect !== 'allow')
    )
      throw new RuntimePolicyError('static_browser_policy_denied');
  }
  const [row] = await tx<
    StaticBrowserVerificationRow[]
  >`select v.* from allrice_static_browser_verifications v
    join allrice_jobs j on j.id=v.job_id and j.run_id=v.run_id and j.organization_id=v.organization_id
      and j.workspace_id=v.workspace_id and j.owner_id=v.owner_id
    join allrice_runs r on r.id=v.run_id and r.organization_id=v.organization_id and r.workspace_id=v.workspace_id and r.owner_id=v.owner_id
    join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
    join allrice_employee_assignments a on a.id=e.employee_assignment_id and a.organization_id=e.organization_id
      and a.workspace_id=e.workspace_id and a.user_id=e.owner_id and a.active and a.employee_version_id=e.employee_version_id
    join allrice_employees pe on pe.id=a.employee_id and pe.organization_id=v.organization_id
      and pe.workspace_id=v.workspace_id and pe.status='active'
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=v.organization_id
      and p.subject_id=v.owner_id and p.expires_at>clock_timestamp()
    join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=e.organization_id
      and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id
    join allrice_browser_control_grants g on g.id=v.parent_grant_id and g.organization_id=v.organization_id
      and g.workspace_id=v.workspace_id and g.owner_id=v.owner_id and g.version=v.parent_grant_version
    join allrice_execution_targets t on t.id=v.target_id and t.organization_id=v.organization_id and t.workspace_id=v.workspace_id
    where v.id=${id} and v.organization_id=${ctx.organizationId} and v.workspace_id=${ctx.workspaceId} and v.owner_id=${ctx.actor.id}
      and v.run_id=${context.runId} and v.job_id=${context.jobId} and v.worker_id=${context.worker.id}
      and r.policy_snapshot_id=${context.policySnapshot.id} and r.state='running' and c.active_run_id=r.id and c.state='running'
      and e.session_id=v.session_id
      and j.status='running' and j.worker_id=v.worker_id and j.attempt=v.job_attempt and j.lease_token=v.job_lease_token
      and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null
      and g.enabled and g.revoked_at is null and t.state='online' and v.deadline_at>clock_timestamp()
      and v.state in ('admitted','running','completed')
      and g.target_id=v.target_id and g.transport=v.location
      and (v.location<>'cloud' or (t.kind='cloud_sandbox' and t.capabilities ? 'browser.navigate'
        and (t.metadata->>'healthManaged' is distinct from 'true' or t.last_heartbeat_at between clock_timestamp()-interval '120 seconds' and clock_timestamp())))
      and e.execution_snapshot->'capabilitySnapshot'->'bindings'->'toolNames' ? 'browser.workspace'
      and e.execution_snapshot->'capabilitySnapshot'->'grantedCapabilities' ?& array['storage:read','storage:write','network:outbound']
    for share of v,j,r,e,a,pe,p,c,g,t`;
  if (!row) throw new RuntimePolicyError('static_browser_authority_lost');
  return row;
}

/** Lock ordering only. The stored same-owner intent supplies the run/job;
 * active state and policy validity are checked by admission, never by cleanup.
 * Root precedes Job (task clock/publisher), then controls precede browser rows
 * (ledger admission). An invalid/revoked intent must still be stoppable. */
async function lockStaticBrowserPolicy(
  tx: postgres.TransactionSql,
  ctx: ReturnType<typeof browserPrincipal>,
  runId: string,
  jobId: string,
) {
  const roots =
    await tx`select root_run_id from allrice_runtime_roots where root_run_id=${runId}
    and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} for update`;
  if (!roots.length) {
    // Same absent-root creation fence as ledger.createRoot. Acquire it only
    // when absent: an existing ledger already holds root before entering here.
    // This prevents first-operation root creation between nested checks while
    // this transaction holds controls/browser locks.
    await tx`select pg_advisory_xact_lock(hashtextextended(${runId},703))`;
    await tx`select root_run_id from allrice_runtime_roots where root_run_id=${runId}
      and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} for update`;
  }
  await tx`select id from allrice_jobs where id=${jobId} and run_id=${runId}
    and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and owner_id=${ctx.actor.id} for share`;
  await tx`select version from allrice_runtime_policy_controls
    where organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} for update`;
}

export async function lockStaticBrowserWorkspacePolicy(
  tx: postgres.TransactionSql,
  ctx: RuntimePolicyPrincipal,
  workspaceId: string,
) {
  const [intent] = await tx<{ run_id: string; job_id: string }[]>`
    select run_id,job_id from allrice_static_browser_verifications
    where browser_workspace_id=${workspaceId} and organization_id=${ctx.organizationId}
      and workspace_id=${ctx.workspaceId} and owner_id=${ctx.actor.id}`;
  if (intent)
    await lockStaticBrowserPolicy(tx, ctx, intent.run_id, intent.job_id);
}

/** Fresh private browser profile derived from the selected public grant, never
 * its cookies/login state. The same row also owns a fixed cloud attempt. */
export async function admitStaticBrowserVerification(
  input: {
    context: ExecutionContext;
    sessionId: string;
    callId: string;
    target: StaticBrowserTarget;
    plan: BrowserVerificationPlan;
    jobAttempt: number;
    jobLeaseToken: string;
    location: 'local' | 'cloud';
    reason: string;
    grantId: string | null;
    grantVersion: number | null;
    targetId: string | null;
    deviceId: string | null;
    deadlineAt: string;
  },
  db: DB = getDatabase(),
) {
  const ctx = browserPrincipal(input.context),
    target = StaticBrowserTargetSchema.parse(input.target),
    plan = BrowserVerificationPlanSchema.parse(input.plan),
    id = cloudStableId(`static-browser:${input.context.runId}:${input.callId}`),
    workspaceId = cloudStableId(
      `browser:${input.context.runId}:${input.callId}`,
    ),
    requestDigest = digest({
      target,
      plan,
      location: input.location,
      deviceId: input.deviceId,
    });
  return db.begin(async (tx) => {
    await browserIdentity(tx, ctx);
    await lockStaticBrowserPolicy(
      tx,
      ctx,
      input.context.runId,
      input.context.jobId!,
    );
    // Pin the exact Job before the later multi-table authority checks.
    const [job] =
      await tx`select id from allrice_jobs where id=${input.context.jobId}
      and worker_id=${input.context.worker.id} and attempt=${input.jobAttempt} and lease_token=${input.jobLeaseToken}
      and status='running' and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp()
      and cancel_requested_at is null for update`;
    if (!job) throw new RuntimePolicyError('static_browser_job_changed');
    await assertPublishingRun(
      tx,
      input.context,
      input.sessionId,
      'browser.workspace',
    );
    const [prior] = await tx<
      StaticBrowserVerificationRow[]
    >`select * from allrice_static_browser_verifications where id=${id}`;
    if (prior) {
      if (
        prior.request_digest !== requestDigest ||
        prior.job_lease_token !== input.jobLeaseToken
      )
        throw new RuntimePolicyError('idempotency_conflict');
      return prior;
    }
    const [grant] = await tx<
      { id: string; version: number; target_id: string; profile: unknown }[]
    >`select g.id,g.version,g.target_id,g.profile
      from allrice_browser_control_grants g join allrice_execution_targets t on t.id=g.target_id
        and t.organization_id=g.organization_id and t.workspace_id=g.workspace_id
      where g.organization_id=${ctx.organizationId} and g.workspace_id=${ctx.workspaceId} and g.owner_id=${ctx.actor.id}
        and g.transport=${input.location} and g.enabled and g.revoked_at is null and t.state='online'
        and g.id=${input.grantId}::uuid and g.version=${input.grantVersion} and g.target_id=${input.targetId}::uuid
        and (g.transport<>'cloud' or (t.kind='cloud_sandbox' and t.capabilities ? 'browser.navigate'
          and (t.metadata->>'healthManaged' is distinct from 'true' or t.last_heartbeat_at between clock_timestamp()-interval '120 seconds' and clock_timestamp())))
        and (${input.deviceId}::uuid is null or t.target_key='bridge.'||${input.deviceId}::text)
      for share of g,t`;
    if (
      !grant ||
      (input.location === 'local' && !input.deviceId) ||
      (input.location === 'cloud' &&
        !browserOriginAllowed(
          staticBrowserDocumentUrl(target),
          BrowserProfileSchema.parse(grant.profile),
        ))
    )
      throw new RuntimePolicyError('static_browser_grant_denied');
    const deadline = new Date(
      Math.min(Date.parse(input.deadlineAt), Date.now() + 90_000),
    );
    await tx`insert into allrice_static_browser_verifications(id,organization_id,workspace_id,owner_id,run_id,session_id,job_id,
      worker_id,job_attempt,job_lease_token,call_id,request_digest,target,plan,execution_context,location,execution_reason,
      device_id,browser_workspace_id,target_id,parent_grant_id,parent_grant_version,attempt_id,deadline_at)
      values(${id},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${input.context.runId},${input.sessionId},${input.context.jobId},
      ${input.context.worker.id},${input.jobAttempt},${input.jobLeaseToken},${input.callId},${requestDigest},${tx.json(target)},${tx.json(plan)},
      ${tx.json(input.context as never)},${input.location},${input.reason},${input.deviceId},${input.location === 'local' ? workspaceId : null},
      ${grant.target_id},${grant.id},${grant.version},${cloudStableId(`static-browser-attempt:${id}`)},${deadline})`;
    if (input.location === 'local') {
      const grantId = cloudStableId(`static-browser-grant:${id}`),
        profileId = randomUUID();
      const profile = BrowserProfileSchema.parse({
        version: 1,
        origins: [new URL(staticBrowserDocumentUrl(target)).origin],
        allowUploads: false,
        allowDownloads: false,
        allowHumanCredentials: false,
        maximumFileBytes: 100_000,
        lifetimeMs: 90_000,
      });
      await tx`insert into allrice_browser_control_grants(id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled,transport)
        values(${grantId},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${grant.target_id},1,${tx.json(profile)},true,'local')`;
      await tx`insert into allrice_local_browser_grants(grant_id,organization_id,workspace_id,owner_id,device_id,logical_profile_id,persist_login,purpose)
        values(${grantId},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${input.deviceId},${randomUUID()},false,'static_artifact')`;
      await tx`insert into allrice_browser_workspaces(id,organization_id,workspace_id,owner_id,run_id,session_id,job_id,worker_id,
        job_lease_token,job_attempt,task_id,grant_id,grant_version,profile_id,profile,execution_context,expires_at,transport)
        values(${workspaceId},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${input.context.runId},${input.sessionId},${input.context.jobId},
        ${input.context.worker.id},${input.jobLeaseToken},${input.jobAttempt},null,${grantId},1,${profileId},${tx.json(profile)},${tx.json(input.context as never)},${deadline},'local')`;
      await tx`insert into allrice_local_browser_workspaces(browser_workspace_id,organization_id,workspace_id,owner_id,device_id,grant_id,request_digest)
        values(${workspaceId},${ctx.organizationId},${ctx.workspaceId},${ctx.actor.id},${input.deviceId},${grantId},${requestDigest})`;
      await currentBrowserWorkspace(tx, ctx, workspaceId);
    }
    return currentStaticBrowserVerification(tx, input.context, id);
  });
}

export async function currentStaticBrowserTarget(
  tx: postgres.TransactionSql,
  w: BrowserWorkspaceRow,
) {
  const [r] = await tx<
    { id: string; target: unknown }[]
  >`select id,target from allrice_static_browser_verifications
    where browser_workspace_id=${w.id} and organization_id=${w.organization_id} and workspace_id=${w.workspace_id}
      and owner_id=${w.owner_id} and run_id=${w.run_id} and location='local' and device_id=${w.device_id}
      and state in ('admitted','running')`;
  if (!r) throw new RuntimePolicyError('static_browser_authority_lost');
  await currentStaticBrowserVerification(tx, w.execution_context, r.id);
  return StaticBrowserTargetSchema.parse(r.target);
}

/** Stop reconciliation uses the original owner/worker/attempt binding, never
 * the permission to execute. Revoked or expired verification cannot prevent
 * stopping its existing controller; no replacement controller is created. */
export async function requestStaticBrowserStop(
  row: StaticBrowserVerificationRow,
  db: DB = getDatabase(),
) {
  if (!row.browser_workspace_id) return;
  if (
    await browserStopConfirmed(
      row.execution_context,
      row.browser_workspace_id,
      row.job_attempt,
      row.job_lease_token,
      db,
    )
  )
    return;
  const [w] = await db<
    { id: string; control_fence: number }[]
  >`select w.id,w.control_fence from allrice_browser_workspaces w
    join allrice_static_browser_verifications v on v.browser_workspace_id=w.id and v.run_id=w.run_id and v.job_id=w.job_id
    where v.id=${row.id} and w.organization_id=${row.organization_id} and w.workspace_id=${row.workspace_id} and w.owner_id=${row.owner_id}
      and w.worker_id=${row.worker_id} and w.job_attempt=${row.job_attempt} and w.job_lease_token=${row.job_lease_token}`;
  if (!w) throw new RuntimePolicyError('static_browser_stop_denied');
  await requestBrowserControl(
    browserPrincipal(row.execution_context),
    w.id,
    {
      requestId: randomUUID(),
      expectedFence: w.control_fence,
      control: 'closed',
      observationId: null,
    },
    db,
  );
}

export async function readLocalStaticBrowserDocument(
  device: BridgeDevice,
  input: LocalControllerIdentity,
  storage: StoragePort,
  db: DB = getDatabase(),
) {
  const w = await db.begin(
    async (tx) =>
      (await lockLocalBrowserController(tx, device, input)).workspace,
  );
  if (!w.staticTarget)
    throw new RuntimePolicyError('static_browser_source_denied');
  const document = await resolveStaticBrowserDocument(
    w.execution_context,
    {
      versionId: w.staticTarget.versionId,
      checksum: w.staticTarget.checksum,
    },
    storage,
    db,
  );
  if (digest(document.target) !== digest(w.staticTarget))
    throw new RuntimePolicyError('static_browser_source_changed');
  await db.begin((tx) => lockLocalBrowserController(tx, device, input));
  return document;
}
