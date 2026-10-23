import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  createNativeScheduleControlSqlStore,
  type NativeOnceClosedProof,
} from './native-schedule-control-sql.ts';
import {
  nativeOnceDigest,
  type NativeOnceReference,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';
import {
  nativeOnceWorkspaceDigest,
  type NativeOnceWorkspaceMutation,
} from './native-schedule-workspace-state.ts';
import {
  applyNativeScheduleControlUpgrade,
  prepareNativeScheduleControlUpgrade,
  readNativeScheduleControlUpgrade,
  NATIVE_CONTROL_UPGRADE_GENERATION,
  type NativeControlArtifactCompatibilityEvidence,
  type NativeControlOfflineStoppedAttestation,
  type NativeControlUpgradeApproval,
  type NativeScheduleControlUpgradePlan,
} from './native-schedule-control-upgrade.ts';

const run =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const pin = (text: string) => nativeOnceDigest(text);
const ready = {
  enabled: true,
  storageReady: true,
  legacyClockExcluded: true,
  controlArtifactApproved: true,
};
type Prepared = { plan: NativeScheduleControlUpgradePlan; planDigest: string };

run('offline control artifact upgrade in an owned synthetic SQL schema', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  let db: Sql;
  const owner = randomUUID(),
    org = randomUUID(),
    workspace = randomUUID();
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    db = fixture.db;
    const [scope] = await db<
      { database: string; schema: string }[]
    >`select current_database() database,current_schema() schema`;
    expect(scope!.database).toBe(
      new URL(process.env.ALLRICE_TEST_DATABASE_URL!).pathname.slice(1),
    );
    expect(scope!.schema).toMatch(/^p25_[a-f0-9]{32}$/);
    await db`insert into allrice_users(id,email,display_name,password_hash) values(${owner},${`${owner}@example.test`},'Synthetic upgrade','not-login')`;
    await db`insert into allrice_organizations(id,slug,name) values(${org},${`upgrade-${org}`},'Synthetic upgrade')`;
    await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'upgrade','Synthetic upgrade')`;
  }, 120_000);
  afterAll(async () => {
    if (fixture)
      console.info(
        'CONTROL_CLOUD_SQL_CLEANUP',
        JSON.stringify(await fixture.close()),
      );
  }, 30_000);
  async function clock() {
    const [r] = await db<
      { ms: number }[]
    >`select floor(extract(epoch from clock_timestamp())*1000)::float8 ms`;
    return r!.ms;
  }
  function controlStore(
    partitionId: string,
    reference: NativeOnceReference,
    sessionId: string,
    ownerId: string = randomUUID(),
  ) {
    return createNativeScheduleControlSqlStore({
      db,
      partitionId,
      reference,
      ownerId,
      ttlMs: 300_000,
      readiness: () => ready,
      loadControls: async () => [{ controlSessionId: sessionId }],
      proveClosed: async (
        w: NativeOnceWriter,
      ): Promise<NativeOnceClosedProof> => ({
        kind: 'verified_process_exit',
        proofId: randomUUID(),
        partitionId,
        ownerId: w.ownerId,
        epoch: w.epoch,
        tokenDigest: nativeOnceDigest(w.token),
        evidence: { syntheticExitDigest: pin('exit') },
      }),
    });
  }
  function evidence(
    before: NativeOnceReference,
    after: NativeOnceReference,
  ): NativeControlArtifactCompatibilityEvidence {
    return {
      kind: 'reviewed-native-control-compatibility-v1' as const,
      generation: NATIVE_CONTROL_UPGRADE_GENERATION,
      beforeReference: {
        ...before,
        profileId: before.profileId as
          'allrice-once-control-v1' | 'allrice-recurring-control-v1',
      },
      afterReference: {
        ...after,
        profileId: after.profileId as
          'allrice-once-control-v1' | 'allrice-recurring-control-v1',
      },
      artifactVerificationDigest: pin('public artifact decode'),
      publicHistoryVerificationDigest: pin('original JSONL read'),
    };
  }
  async function prepare(
    c: Awaited<ReturnType<typeof seed>>,
    extra: { ttlMs?: number; after?: NativeOnceReference } = {},
  ) {
    const after = extra.after ?? c.after;
    return prepareNativeScheduleControlUpgrade({
      db,
      requestId: randomUUID(),
      partitionId: c.partitionId,
      beforeReference: c.before,
      afterReference: after,
      artifactEvidence: evidence(c.before, after),
      ...(extra.ttlMs === undefined ? {} : { ttlMs: extra.ttlMs }),
    });
  }
  async function authorize(p: Prepared) {
    const at = await clock();
    const offline: NativeControlOfflineStoppedAttestation = {
      kind: 'offlineStopped',
      environment: 'dev',
      planId: p.plan.planId,
      planDigest: p.planDigest,
      observedAtMs: at,
      expiresAtMs: Math.min(at + 100_000, p.plan.expiresAtMs),
      operatorEvidenceDigest: pin('source operator evidence'),
      locks: ['/synthetic/maintenance.lock', '/synthetic/delivery.lock'].map(
        (path) => ({
          path,
          ownerPid: 7301,
          ownerBirth: 'synthetic-root-birth',
          tokenDigest: pin(path),
          acquiredAtMs: p.plan.createdAtMs - 100,
          ownershipEvidenceDigest: pin(`owned ${path}`),
        }),
      ),
      processes: [
        {
          role: 'web',
          pid: 7302,
          birth: 'synthetic-web-birth',
          stopMode: 'normal',
          stopRequestedAtMs: p.plan.createdAtMs - 50,
          exitConfirmedAtMs: p.plan.createdAtMs - 10,
          exitEvidenceDigest: pin('web exit'),
        },
        {
          role: 'worker',
          pid: 7303,
          birth: 'synthetic-worker-birth',
          stopMode: 'normal',
          stopRequestedAtMs: p.plan.createdAtMs - 50,
          exitConfirmedAtMs: p.plan.createdAtMs - 10,
          exitEvidenceDigest: pin('worker exit'),
        },
      ],
    };
    const approval: NativeControlUpgradeApproval = {
      kind: 'native-control-upgrade-approval-v1',
      approved: true,
      reviewedBy: 'synthetic-root-policy',
      reviewedAtMs: at,
      reviewPolicyDigest: pin('reviewed source policy'),
      planId: p.plan.planId,
      planDigest: p.planDigest,
      artifactEvidenceDigest: p.plan.artifactEvidenceDigest,
      attestationDigest: nativeOnceDigest(offline),
    };
    return { approval, offlineStoppedAttestation: offline };
  }
  function expected(p: Prepared, auth: Awaited<ReturnType<typeof authorize>>) {
    return {
      planDigest: p.planDigest,
      approvalDigest: nativeOnceDigest(auth.approval),
      attestationDigest: nativeOnceDigest(auth.offlineStoppedAttestation),
    };
  }
  async function apply(
    p: Prepared,
    auth?: Awaited<ReturnType<typeof authorize>>,
    connection = db,
  ) {
    return applyNativeScheduleControlUpgrade({
      db: connection,
      planId: p.plan.planId,
      planDigest: p.planDigest,
      ...(auth ?? (await authorize(p))),
    });
  }
  async function seed(
    profileId:
      | 'allrice-once-control-v1'
      | 'allrice-recurring-control-v1' = 'allrice-recurring-control-v1',
    closed = true,
    history = false,
    withWorkspace = true,
  ) {
    const partitionId = `upgrade-${randomUUID()}`,
      sessionId = randomUUID(),
      automationId = randomUUID(),
      controlId = randomUUID(),
      occurrenceId = randomUUID(),
      clientMessageId = randomUUID();
    const before: NativeOnceReference = {
      artifactId: pin(`old-${partitionId}`),
      profileId,
      storageId: `storage-${partitionId}`,
      stateRoot: `/synthetic/${partitionId}`,
    };
    const after = { ...before, artifactId: pin(`new-${partitionId}`) };
    const taskId = `retained-task-${partitionId}`;
    const writer: NativeOnceWriter = {
      partitionId,
      ownerId: randomUUID(),
      epoch: 1,
      token: randomUUID(),
    };
    await db`insert into allrice_native_once_partitions(partition_id,reference,activation,owner_id,epoch,token_digest,expires_at,closed,close_proof)
      values(${partitionId},${db.json({ ...before })},${db.json(ready)},${writer.ownerId},1,${nativeOnceDigest(writer.token)},clock_timestamp()+interval '5 minutes',false,'null'::jsonb)`;
    await db`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,schedule)
      values(${automationId},${org},${workspace},${owner},'Synthetic retained task','Synthetic only','{"frequency":"daily"}')`;
    const control = {
      kind: 'recurring',
      partitionId,
      controlId,
      automationId,
      revision: 1,
      controlSessionId: sessionId,
      nativeTaskId: taskId,
      dispatch: { occurrenceId, clientMessageId },
      originalSource: 'retained-source',
    };
    if (profileId === 'allrice-once-control-v1') {
      await db`insert into allrice_native_once_controls(partition_id,control_id,automation_id,revision,control_session_id,native_task_id,occurrence_id,client_message_id,immutable_control,snapshot)
        values(${partitionId},${controlId},${automationId},1,${sessionId},${taskId},${occurrenceId},${clientMessageId},${db.json(control)},${db.json({ control, retainedLog: ['original entry'] })})`;
      if (history)
        await db`insert into allrice_native_once_occurrences(occurrence_id,partition_id,control_id,automation_id,revision,scheduled_at,occurrence_key,payload_digest,payload,outbox_state,outbox_reason)
        values(${occurrenceId},${partitionId},${controlId},${automationId},1,'2026-01-01T00:00:00.000Z',${randomUUID()},${pin('old receipt')},
          ${db.json({ control, receipt: { scheduledAt: '2026-01-01T00:00:00.000Z' } })},'blocked','historical authorization rejected')`;
    } else {
      await db`insert into allrice_native_recurring_versions(automation_id,revision,configuration) values(${automationId},1,'{"revision":1}')`;
      await db`insert into allrice_native_recurring_controls(partition_id,control_id,automation_id,control_session_id,native_task_id,immutable_identity,snapshot)
        values(${partitionId},${controlId},${automationId},${sessionId},${taskId},${db.json(control)},${db.json({ control, retainedLog: ['original entry'] })})`;
      if (history)
        await db`insert into allrice_native_recurring_occurrences(occurrence_id,partition_id,control_id,automation_id,revision,scheduled_at,occurrence_key,client_message_id,payload_digest,payload,outbox_state,business_binding)
        values(${occurrenceId},${partitionId},${controlId},${automationId},1,'2026-01-01T00:00:00.000Z',${randomUUID()},${clientMessageId},${pin('old receipt')},
          ${db.json({ control, revision: { revision: 1 }, receipt: { scheduledAt: '2026-01-01T00:00:00.000Z' } })},'enqueued','{"retained":"original queue handoff"}')`;
    }
    const store = controlStore(partitionId, before, sessionId, writer.ownerId);
    const mutation: NativeOnceWorkspaceMutation = {
      kind: 'put_record',
      table: 'workspaces',
      key: 'control-workspace',
      value: {
        path: before.stateRoot,
        title: 'Retained control workspace',
        sessionIds: [sessionId],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const write = {
      writeId: randomUUID(),
      expectedRevision: 0,
      mutation,
      digest: nativeOnceWorkspaceDigest(
        {
          entryKind: 'workspace',
          unitVersion: 2,
          expectedRevision: 0,
          mutation,
        },
        true,
      ),
    };
    if (withWorkspace) await store.commitWorkspaceWrite(writer, write);
    if (closed) await store.releaseClosedWriter(writer);
    return {
      partitionId,
      sessionId,
      automationId,
      controlId,
      occurrenceId,
      clientMessageId,
      before,
      after,
      writer,
      store,
      write,
    };
  }
  async function row(partitionId: string) {
    const [r] = await db<
      { value: Record<string, unknown> }[]
    >`select to_jsonb(p) value from allrice_native_once_partitions p where partition_id=${partitionId}`;
    return r!.value;
  }
  async function facts(partitionId: string) {
    const [r] = await db<
      { value: NativeScheduleControlUpgradePlan['facts'] }[]
    >`select allrice_native_control_upgrade_facts(${partitionId}) value`;
    return r!.value;
  }

  it('keeps both once and recurring histories byte-identical; only artifact reference changes', async () => {
    for (const profile of [
      'allrice-once-control-v1',
      'allrice-recurring-control-v1',
    ] as const) {
      const c = await seed(profile, true, true),
        before = await row(c.partitionId),
        p = await prepare(c),
        auth = await authorize(p);
      const receipt = await apply(p, auth),
        after = await row(c.partitionId),
        current = await facts(c.partitionId);
      expect(after).toEqual({ ...before, reference: c.after });
      expect(current.protected).toEqual(p.plan.facts.protected);
      expect(current.latestWorkspaceJournal).toEqual(
        p.plan.facts.latestWorkspaceJournal,
      );
      expect(current.partitionInvariantPin).toBe(
        p.plan.facts.partitionInvariantPin,
      );
      expect(
        await readNativeScheduleControlUpgrade({
          db,
          planId: p.plan.planId,
          expected: expected(p, auth),
        }),
      ).toMatchObject({ status: 'applied', sequence: receipt.sequence });
      expect(
        await readNativeScheduleControlUpgrade({ db, planId: p.plan.planId }),
      ).toMatchObject({ status: 'plan_only' });
      await expect(apply(p, auth)).rejects.toThrow(
        'already_applied_readback_only',
      );
    }
  });
  it('does not prepare a live/expired-but-unclosed writer or an unaudited/fake close', async () => {
    const c = await seed('allrice-recurring-control-v1', false);
    await db`update allrice_native_once_partitions set expires_at=clock_timestamp()-interval '1 hour' where partition_id=${c.partitionId}`;
    await expect(prepare(c)).rejects.toThrow('invalid_input');
    const fake = {
      kind: 'verified_process_exit',
      proofId: randomUUID(),
      partitionId: c.partitionId,
      ownerId: c.writer.ownerId,
      epoch: 1,
      tokenDigest: nativeOnceDigest(c.writer.token),
      evidence: { fake: true },
    };
    await db`update allrice_native_once_partitions set closed=true,close_proof=${db.json(fake)} where partition_id=${c.partitionId}`;
    await expect(prepare(c)).rejects.toThrow('invalid_input');
  });
  it('rejects cross-generation/profile/storage/root changes and any artifact evidence mismatch', async () => {
    const c = await seed();
    for (const after of [
      { ...c.after, profileId: 'allrice-once-control-v1' },
      { ...c.after, storageId: 'other' },
      { ...c.after, stateRoot: '/other-root' },
    ])
      await expect(prepare(c, { after })).rejects.toThrow(
        'reference_scope_changed',
      );
    await expect(
      prepareNativeScheduleControlUpgrade({
        db,
        requestId: randomUUID(),
        partitionId: c.partitionId,
        beforeReference: c.before,
        afterReference: c.after,
        artifactEvidence: {
          ...evidence(c.before, c.after),
          generation: 'unapproved-generation',
        } as never,
      }),
    ).rejects.toThrow('invalid_input');
    await expect(
      prepareNativeScheduleControlUpgrade({
        db,
        requestId: randomUUID(),
        partitionId: c.partitionId,
        beforeReference: c.before,
        afterReference: c.after,
        artifactEvidence: evidence(c.before, {
          ...c.after,
          artifactId: pin('unrelated'),
        }),
      }),
    ).rejects.toThrow('reference_scope_changed');
  });
  it('rejects missing approval/offline evidence, wrong hashes, stopped identities and expired attestations', async () => {
    const c = await seed(),
      p = await prepare(c),
      a = await authorize(p);
    const altered = [
      { ...a, approval: { ...a.approval, approved: false } },
      { ...a, approval: { ...a.approval, planDigest: pin('wrong') } },
      { ...a, approval: { ...a.approval, attestationDigest: pin('wrong') } },
      { ...a, offlineStoppedAttestation: undefined },
      {
        ...a,
        offlineStoppedAttestation: {
          ...a.offlineStoppedAttestation,
          kind: 'quiesced',
        },
      },
      {
        ...a,
        offlineStoppedAttestation: {
          ...a.offlineStoppedAttestation,
          processes: [],
        },
      },
    ];
    for (const invalid of altered)
      await expect(apply(p, invalid as never)).rejects.toThrow();
    for (const mutate of [
      (v: NativeControlOfflineStoppedAttestation) => {
        v.expiresAtMs = v.observedAtMs;
      },
      (v: NativeControlOfflineStoppedAttestation) => {
        v.locks[1]!.path = v.locks[0]!.path;
      },
      (v: NativeControlOfflineStoppedAttestation) => {
        v.processes[1]!.role = 'web';
      },
      (v: NativeControlOfflineStoppedAttestation) => {
        v.processes[0]!.exitConfirmedAtMs = p.plan.createdAtMs + 1000;
      },
    ]) {
      const modified = structuredClone(a);
      mutate(modified.offlineStoppedAttestation);
      modified.approval.attestationDigest = nativeOnceDigest(
        modified.offlineStoppedAttestation,
      );
      await expect(apply(p, modified)).rejects.toThrow();
    }
    expect(
      await readNativeScheduleControlUpgrade({
        db,
        planId: p.plan.planId,
        expected: expected(p, a),
      }),
    ).toMatchObject({ status: 'not_applied' });
  });
  it('rejects expired durable plans and immutable plan/ledger edits', async () => {
    const c = await seed(),
      p = await prepare(c, { ttlMs: 250 }),
      a = await authorize(p);
    await expect(
      db`update allrice_native_control_upgrade_plans set plan=plan||'{"tampered":true}' where plan_id=${p.plan.planId}`,
    ).rejects.toThrow('immutable');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(apply(p, a)).rejects.toThrow('approval_expired');
    const next = await prepare(c),
      auth = await authorize(next);
    await apply(next, auth);
    await expect(
      db`update allrice_native_control_upgrades set after_reference=before_reference where plan_id=${next.plan.planId}`,
    ).rejects.toThrow('immutable');
    await expect(
      db`delete from allrice_native_control_upgrades where plan_id=${next.plan.planId}`,
    ).rejects.toThrow('immutable');
    await expect(
      db`update allrice_native_once_partitions set reference=${db.json({ ...c.before })} where partition_id=${c.partitionId}`,
    ).rejects.toThrow('exact closed upgrade ledger');
  });
  it('uses CAS under competing plans and rejects state changes after prepare', async () => {
    const c = await seed(),
      p = await prepare(c),
      other = await prepare(c, {
        after: { ...c.after, artifactId: pin('other reviewed artifact') },
      });
    const auth = await authorize(p),
      otherAuth = await authorize(other);
    const results = await Promise.allSettled([
      apply(p, auth),
      apply(other, otherAuth),
    ]);
    expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((v) => v.status === 'rejected')).toHaveLength(1);
    const [count] = await db<
      { n: number }[]
    >`select count(*)::int n from allrice_native_control_upgrades where partition_id=${c.partitionId}`;
    expect(count!.n).toBe(1);
    const c2 = await seed(),
      p2 = await prepare(c2),
      auth2 = await authorize(p2);
    await db`update allrice_native_recurring_controls set snapshot_version=snapshot_version+1,snapshot=snapshot||'{"newLog":"new fact"}' where partition_id=${c2.partitionId}`;
    await expect(apply(p2, auth2)).rejects.toThrow('snapshot_changed');
  });
  it('requires current idle readback; historical blocked/enqueued outboxes remain eligible', async () => {
    const c = await seed('allrice-once-control-v1', true, true),
      p = await prepare(c),
      a = await authorize(p);
    const busy = await seed('allrice-once-control-v1');
    const [ctrl] = await db<
      { immutable_control: Record<string, unknown> }[]
    >`select immutable_control from allrice_native_once_controls where partition_id=${busy.partitionId}`;
    await db`insert into allrice_native_once_occurrences(occurrence_id,partition_id,control_id,automation_id,revision,scheduled_at,occurrence_key,payload_digest,payload,outbox_state)
      values(${busy.occurrenceId},${busy.partitionId},${busy.controlId},${busy.automationId},1,'2026-01-01T00:00:00.000Z',${randomUUID()},${pin('pending')},
        ${db.json(JSON.parse(JSON.stringify({ control: ctrl!.immutable_control, receipt: { scheduledAt: '2026-01-01T00:00:00.000Z' } })))},'pending')`;
    try {
      await expect(prepare(busy)).rejects.toThrow('not_idle');
      await expect(apply(p, a)).rejects.toThrow('not_idle');
    } finally {
      await db`update allrice_native_once_occurrences set outbox_state='blocked',outbox_reason='synthetic final rejection' where occurrence_id=${busy.occurrenceId}`;
    }
    await apply(p, a);
  });
  it('restores the same old workspace through A→B→C and keeps old writer/COMMIT fences', async () => {
    const c = await seed(),
      p = await prepare(c);
    const firstAuthorization = await authorize(p);
    await apply(p, firstAuthorization);
    const [crossZone] = await db.begin(async (tx) => {
      await tx`select set_config('TimeZone','Asia/Shanghai',true)`;
      return tx<
        { allowed: boolean }[]
      >`select allrice_native_control_upgrade_workspace_allowed(
        ${c.partitionId},${tx.json({ ...c.after })},${p.plan.workspaceDigest},${c.write.writeId}) allowed`;
    });
    expect(crossZone!.allowed).toBe(true);
    await expect(c.store.acquireWriter()).rejects.toThrow('reference_changed');
    const b = controlStore(c.partitionId, c.after, c.sessionId),
      grant = await b.acquireWriter();
    expect(grant).not.toBeNull();
    const snapshot = await b.loadWorkspaceUnit(grant!.writer);
    expect(snapshot.revision).toBe(1);
    await expect(c.store.loadWorkspaceUnit(c.writer)).rejects.toThrow(
      'lease_lost',
    );
    await expect(
      db.begin(async (tx) => {
        await tx`insert into allrice_native_once_journal(partition_id,write_id,entry_kind,control_id,writer_owner_id,writer_epoch,writer_token_digest,reference,write_digest,mutation,journal,after_snapshot,after_digest)
        select partition_id,${randomUUID()},entry_kind,control_id,writer_owner_id,writer_epoch,writer_token_digest,reference,write_digest,mutation,journal,after_snapshot,after_digest
        from allrice_native_once_journal where partition_id=${c.partitionId} and write_id=${c.write.writeId}`;
      }),
    ).rejects.toThrow('COMMIT writer fence lost');
    await b.releaseClosedWriter(grant!.writer);
    const cRef = {
      ...c.after,
      artifactId: pin('third reviewed execution artifact'),
    };
    const second = await prepareNativeScheduleControlUpgrade({
      db,
      requestId: randomUUID(),
      partitionId: c.partitionId,
      beforeReference: c.after,
      afterReference: cRef,
      artifactEvidence: evidence(c.after, cRef),
    });
    await apply(second);
    const third = controlStore(c.partitionId, cRef, c.sessionId),
      g = await third.acquireWriter();
    expect(await third.loadWorkspaceUnit(g!.writer)).toEqual(snapshot);
    const mutation: NativeOnceWorkspaceMutation = {
      kind: 'set_global',
      value: {
        initialized: true,
        workspaceIds: ['control-workspace'],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    };
    const write = {
      writeId: randomUUID(),
      expectedRevision: 1,
      mutation,
      digest: nativeOnceWorkspaceDigest(
        {
          entryKind: 'workspace',
          unitVersion: 2,
          expectedRevision: 1,
          mutation,
        },
        true,
      ),
    };
    expect(await third.commitWorkspaceWrite(g!.writer, write)).toEqual({
      revision: 2,
    });
    await third.releaseClosedWriter(g!.writer);
    expect(
      await readNativeScheduleControlUpgrade({
        db,
        planId: p.plan.planId,
        expected: expected(p, firstAuthorization),
      }),
    ).toMatchObject({ status: 'applied' });
  });
  it('upgrades a genuinely empty workspace and starts its first new-reference journal normally', async () => {
    const c = await seed('allrice-once-control-v1', true, false, false),
      p = await prepare(c);
    expect(p.plan.workspaceDigest).toBeNull();
    expect(p.plan.facts.latestWorkspaceJournal).toBeNull();
    await apply(p);
    const next = controlStore(c.partitionId, c.after, c.sessionId),
      g = await next.acquireWriter();
    expect(await next.loadWorkspaceUnit(g!.writer)).toEqual({
      unitVersion: 2,
      revision: 0,
      tables: { workspaces: {} },
      global: null,
    });
    expect(await next.commitWorkspaceWrite(g!.writer, c.write)).toEqual({
      revision: 1,
    });
    await next.releaseClosedWriter(g!.writer);
  });
  it('rejects incomplete offline facts in SQL even when their supplied document digests match', async () => {
    const c = await seed(),
      p = await prepare(c),
      auth = await authorize(p);
    const missingObserved: Record<string, unknown> = {
      ...auth.offlineStoppedAttestation,
    };
    delete missingObserved.observedAtMs;
    for (const offline of [
      { ...auth.offlineStoppedAttestation, locks: [] },
      missingObserved,
      { ...auth.offlineStoppedAttestation, observedAtMs: null },
      { ...auth.offlineStoppedAttestation, expiresAtMs: null },
    ]) {
      const approval = {
        ...auth.approval,
        attestationDigest: nativeOnceDigest(offline),
      };
      await expect(db`insert into allrice_native_control_upgrades(plan_id,partition_id,plan_digest,before_reference,after_reference,
      workspace_digest,latest_journal_pin,previous_sequence,approval,approval_digest,offline_attestation,attestation_digest)
      values(${p.plan.planId},${c.partitionId},${p.planDigest},${db.json({ ...c.before })},${db.json({ ...c.after })},${p.plan.workspaceDigest},
        ${db.json(p.plan.facts.latestWorkspaceJournal)},${p.plan.facts.previousSequence},${db.json(approval)},${nativeOnceDigest(approval)},
        ${db.json(JSON.parse(JSON.stringify(offline)))},${nativeOnceDigest(offline)})`).rejects.toThrow(
        'offline fence rejected',
      );
    }
    const missingReview: Record<string, unknown> = { ...auth.approval };
    delete missingReview.reviewedAtMs;
    for (const approval of [
      missingReview,
      { ...auth.approval, reviewedAtMs: null },
      { ...auth.approval, approved: 'true' },
    ]) {
      await expect(db`insert into allrice_native_control_upgrades(plan_id,partition_id,plan_digest,before_reference,after_reference,
        workspace_digest,latest_journal_pin,previous_sequence,approval,approval_digest,offline_attestation,attestation_digest)
        values(${p.plan.planId},${c.partitionId},${p.planDigest},${db.json({ ...c.before })},${db.json({ ...c.after })},${p.plan.workspaceDigest},
          ${db.json(p.plan.facts.latestWorkspaceJournal)},${p.plan.facts.previousSequence},${db.json(JSON.parse(JSON.stringify(approval)))},${nativeOnceDigest(approval)},
          ${db.json(auth.offlineStoppedAttestation)},${nativeOnceDigest(auth.offlineStoppedAttestation)})`).rejects.toThrow(
        'offline fence rejected',
      );
    }
    const missingExpiry: Record<string, unknown> = {
      ...p.plan,
      planId: randomUUID(),
    };
    delete missingExpiry.expiresAtMs;
    for (const invalid of [
      missingExpiry,
      { ...p.plan, planId: randomUUID(), expiresAtMs: null },
    ]) {
      await expect(db`insert into allrice_native_control_upgrade_plans(plan_id,partition_id,plan_digest,plan)
        values(${String(invalid.planId)},${c.partitionId},${nativeOnceDigest(invalid)},${db.json(JSON.parse(JSON.stringify(invalid)))})`).rejects.toThrow(
        'not a closed idle snapshot',
      );
    }
    expect((await row(c.partitionId)).reference).toEqual(c.before);
  });
  it('re-anchors a later upgrade after B commits a real workspace journal', async () => {
    const c = await seed(),
      p = await prepare(c);
    await apply(p);
    const b = controlStore(c.partitionId, c.after, c.sessionId),
      g = await b.acquireWriter();
    const mutation: NativeOnceWorkspaceMutation = {
      kind: 'set_global',
      value: {
        initialized: true,
        workspaceIds: ['control-workspace'],
        archivedSessionIds: [],
        pinnedSessionIds: [c.sessionId],
      },
    };
    const write = {
      writeId: randomUUID(),
      expectedRevision: 1,
      mutation,
      digest: nativeOnceWorkspaceDigest(
        {
          entryKind: 'workspace',
          unitVersion: 2,
          expectedRevision: 1,
          mutation,
        },
        true,
      ),
    };
    await b.commitWorkspaceWrite(g!.writer, write);
    const snapshot = await b.loadWorkspaceUnit(g!.writer);
    await b.releaseClosedWriter(g!.writer);
    const thirdRef = { ...c.after, artifactId: pin('later C artifact') };
    const later = await prepareNativeScheduleControlUpgrade({
      db,
      requestId: randomUUID(),
      partitionId: c.partitionId,
      beforeReference: c.after,
      afterReference: thirdRef,
      artifactEvidence: evidence(c.after, thirdRef),
    });
    expect(later.plan.facts.latestWorkspaceJournal?.writeId).toBe(
      write.writeId,
    );
    expect(later.plan.facts.latestWorkspaceJournal?.reference).toEqual(c.after);
    await apply(later);
    const third = controlStore(c.partitionId, thirdRef, c.sessionId),
      next = await third.acquireWriter();
    expect(await third.loadWorkspaceUnit(next!.writer)).toEqual(snapshot);
    await third.releaseClosedWriter(next!.writer);
  });
  it('rechecks protected bytes and offline expiry at actual COMMIT, rolling back reference and ledger together', async () => {
    for (const expire of [false, true]) {
      const c = await seed(),
        p = await prepare(c),
        auth = await authorize(p);
      if (expire) {
        auth.offlineStoppedAttestation.expiresAtMs = (await clock()) + 300;
        auth.approval.attestationDigest = nativeOnceDigest(
          auth.offlineStoppedAttestation,
        );
      }
      const original = await row(c.partitionId);
      const fenced = {
        begin: (options: string, work: (tx: unknown) => Promise<unknown>) =>
          db.begin(options, async (tx) => {
            const result = await work(tx);
            if (expire) await tx`select pg_sleep(0.4)`;
            else
              await tx`update allrice_native_recurring_controls set snapshot_version=snapshot_version+1,snapshot=snapshot||'{"unexpected":"new byte"}' where partition_id=${c.partitionId}`;
            return result;
          }),
      } as unknown as Sql;
      await expect(apply(p, auth, fenced)).rejects.toThrow(
        'commit_unknown_readback_only',
      );
      expect(await row(c.partitionId)).toEqual(original);
      expect(
        await readNativeScheduleControlUpgrade({
          db,
          planId: p.plan.planId,
          expected: expected(p, auth),
        }),
      ).toMatchObject({ status: 'not_applied' });
    }
  });
  it('does not accept an old workspace reference without exact persisted lineage or with a changed latest journal pin', async () => {
    const c = await seed(),
      p = await prepare(c);
    await apply(p);
    await db.begin(async (tx) => {
      // This new journal is a legitimate new writer commit but retains the old
      // reference in its row only if the original COMMIT fence is bypassed.
      // Instead change the current snapshot without changing history: restore
      // must reject the digest/pin disagreement, never grant the old ledger.
      const [r] = await tx<
        { workspace_snapshot: Record<string, unknown> }[]
      >`select workspace_snapshot from allrice_native_once_partitions where partition_id=${c.partitionId} for update`;
      await tx`update allrice_native_once_partitions set workspace_snapshot=${tx.json({ ...r!.workspace_snapshot, revision: 2 })} where partition_id=${c.partitionId}`;
    });
    const next = controlStore(c.partitionId, c.after, c.sessionId),
      g = await next.acquireWriter();
    await expect(next.loadWorkspaceUnit(g!.writer)).rejects.toThrow(
      'workspace_snapshot_journal_mismatch',
    );
    await next.releaseClosedWriter(g!.writer);
    const noProof = await seed();
    const [allowed] = await db<
      { allowed: boolean }[]
    >`select allrice_native_control_upgrade_workspace_allowed(${noProof.partitionId},${db.json(noProof.after)},${p.plan.workspaceDigest},${noProof.write.writeId}) allowed`;
    expect(allowed!.allowed).toBe(false);
  });
  it('never retries a lost COMMIT ACK; exact readback distinguishes committed and rolled-back outcomes', async () => {
    for (const committed of [true, false]) {
      const c = await seed(),
        p = await prepare(c),
        a = await authorize(p);
      let calls = 0;
      const uncertain = {
        begin: async (
          options: string,
          work: (tx: unknown) => Promise<unknown>,
        ) => {
          calls++;
          if (committed) {
            await db.begin(options, work as never);
            throw Error('synthetic lost COMMIT ACK');
          }
          return db.begin(options, async (tx) => {
            await work(tx);
            throw Error('synthetic disconnected before COMMIT');
          });
        },
      } as unknown as Sql;
      await expect(apply(p, a, uncertain)).rejects.toThrow(
        'commit_unknown_readback_only',
      );
      expect(calls).toBe(1);
      expect(
        await readNativeScheduleControlUpgrade({
          db,
          planId: p.plan.planId,
          expected: expected(p, a),
        }),
      ).toMatchObject({ status: committed ? 'applied' : 'not_applied' });
      await expect(
        readNativeScheduleControlUpgrade({
          db,
          planId: p.plan.planId,
          expected: { ...expected(p, a), planDigest: pin('different plan') },
        }),
      ).rejects.toThrow('readback_conflict');
      if (committed)
        await expect(
          readNativeScheduleControlUpgrade({
            db,
            planId: p.plan.planId,
            expected: {
              ...expected(p, a),
              approvalDigest: pin('different approval'),
            },
          }),
        ).rejects.toThrow('readback_conflict');
    }
  });
  // Synthetic SQL metadata only: these credentials exercise DB fences, never
  // claim that the real Dev VM was observed or that the historical work settled.
  let historicalCloudSeeded = false;
  const cloudOperation = '44cff0b1-a2db-4953-a7b0-8e74c9f414ec';
  const cloudRun = '0c350e53-4ad8-4e57-bdc0-f4472e74d0d3';
  const cloudJob = '6a42bf8b-9a3b-432a-9fb1-e4123bbccc8a';
  const cloudAttempt = '6275fd00-d4d6-4440-a340-95662caaa7b8';
  let cloudTarget: string;
  async function seedHistoricalCloud() {
    if (historicalCloudSeeded) return;
    cloudTarget = randomUUID();
    const grant = randomUUID();
    await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input,completed_at)
      values(${cloudRun},${org},${workspace},${owner},'failed','{}','{}',clock_timestamp()-interval '1 hour')`;
    await db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload)
      values(${cloudJob},${org},${workspace},${owner},${cloudRun},'failed',${randomUUID()},clock_timestamp()+interval '10 minutes','{}')`;
    await db`insert into allrice_runtime_roots(root_run_id,organization_id,workspace_id,task,deadline_at)
      values(${cloudRun},${org},${workspace},'{}',clock_timestamp()-interval '1 hour')`;
    await db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities)
      values(${cloudTarget},${org},${workspace},${`synthetic.${cloudTarget}`},'cloud_sandbox','Synthetic historical metadata','online','["process.execute"]')`;
    await db`insert into allrice_cloud_execution_grants(id,organization_id,workspace_id,owner_id,target_id,version,profile)
      values(${grant},${org},${workspace},${owner},${cloudTarget},1,'{}')`;
    await db`insert into allrice_runtime_operations(id,organization_id,workspace_id,run_id,root_run_id,target_id,attempt_id,attempt_number,generation,fence,idempotency_key,initial_snapshot,snapshot,lease_owner,lease_token_hash,lease_expires_at)
      values(${cloudOperation},${org},${workspace},${cloudRun},${cloudRun},${cloudTarget},${cloudAttempt},1,1,1,${randomUUID()},'{"status":"unknown"}','{"status":"unknown"}',${randomUUID()},${pin('synthetic expired lease')},clock_timestamp()-interval '1 hour')`;
    await db`insert into allrice_cloud_execution_attempts(operation_id,lease_token) values(${cloudOperation},'synthetic-history-only')`;
    await db`insert into allrice_cloud_execution_inputs(operation_id,organization_id,workspace_id,owner_id,run_id,grant_id,job_id,worker_id,job_lease_token,binding,payload)
      values(${cloudOperation},${org},${workspace},${owner},${cloudRun},${grant},${cloudJob},${randomUUID()},${randomUUID()},${db.json({ attempt: { attemptId: cloudAttempt } })},'{}')`;
    for (const receipt of [
      '4ab77a79-4be3-409b-a49c-4c24c0d1b9ad',
      '5d9c2725-e96f-4e4a-a91a-8df5119b5417',
    ])
      await db`insert into allrice_runtime_operation_receipts(receipt_id,operation_id,payload,disposition)
        values(${receipt},${cloudOperation},'{"syntheticUnresolved":true}','applied')`;
    historicalCloudSeeded = true;
  }
  async function cloudSnapshot() {
    const [v] = await db<
      { snapshot: Record<string, unknown>; database: string; schema: string }[]
    >`
      select allrice_native_control_historical_cloud_snapshot() snapshot,current_database() database,current_schema() schema`;
    return {
      ...v!.snapshot,
      scope: { database: v!.database, schema: v!.schema, readOnly: 'on' },
    };
  }
  async function cloudCredential(
    c: Awaited<ReturnType<typeof seed>>,
    ttlMs = 100_000,
  ) {
    await seedHistoricalCloud();
    const at = await clock(),
      planId = randomUUID();
    const [v] = await db<
      { facts: Record<string, unknown> }[]
    >`select allrice_native_control_upgrade_facts(${c.partitionId}) facts`;
    const locks = [
      '/synthetic/maintenance.lock',
      '/synthetic/delivery.lock',
    ].map((path) => ({
      path,
      ownerPid: 7301,
      ownerBirth: 'synthetic-root-birth',
      tokenDigest: pin(path),
      acquiredAtMs: at - 100,
      ownershipEvidenceDigest: pin(`owned ${path}`),
    }));
    const processes = ['web', 'worker'].map((role, i) => ({
      role,
      pid: 7302 + i,
      birth: `synthetic-${role}-birth`,
      stopMode: 'normal',
      stopRequestedAtMs: at - 50,
      exitConfirmedAtMs: at - 10,
      exitEvidenceDigest: pin(`${role} exit`),
    }));
    const lifecycle = processes.map((p) => ({
      identity: {
        service: p.role,
        pid: p.pid,
        environment: 'dev',
        bootId: `synthetic-${p.role}`,
      },
      producerLifecycle: {
        role: p.role,
        instance: { bootId: `synthetic-${p.role}` },
        releaseAdmission: 'disabled',
        unknownOutcomes: [],
        activeRoots: 0,
        pendingRoots: 0,
        unresolvedRoots: 0,
        retainedChildren: 0,
      },
    }));
    const observation = {
      kind: 'native-control-cloud-absence-observation-v1',
      planId,
      partitionId: c.partitionId,
      beforeReference: c.before,
      afterReference: c.after,
      operationId: cloudOperation,
      readerPin: {
        sha256:
          '96957a756e54118896bd3b75586c62d57b6f725ef263821e5a493ebed59163e9',
      },
      baselinePin: {
        sha256:
          '22e6ba2d85ce9ec1a917b1c032478ccc97fa300070cbbd9a4a97121cea9bd5ce',
      },
      observedAtMs: at,
      expiresAtMs: at + ttlMs,
      locks,
      processes,
      lifecycle,
      lifecyclePin: { sha256: 'b'.repeat(64) },
      controlFacts: v!.facts,
      sqlSnapshot: await cloudSnapshot(),
      physical: {
        configuredSocket: '/synthetic/docker.sock',
        containerName: `allrice-cloud-${cloudAttempt}`,
        nameProbeStatus: 404,
        labelProbeStatus: 200,
        labelMatchIds: [],
      },
      inventory: {
        socketPath: '/synthetic/docker.sock',
        status: 200,
        body: [],
      },
      historicalOutcomeKnown: false,
      cleanupClaimed: false,
      globalResourceIdleProven: false,
    };
    return {
      kind: 'native-control-cloud-absence-credential-v1',
      observation,
      approval: {
        kind: 'native-control-cloud-absence-source-approval-v1',
        reviewedBy: 'root',
        reviewedAtMs: at,
        observationDigest: nativeOnceDigest(observation),
        reviewPolicyDigest: pin('synthetic root source policy'),
        offlineProofDigest: pin('synthetic original stop proof'),
        operatorSha256: 'a'.repeat(64),
        verifierSha256: 'b'.repeat(64),
        releaseSha: 'c'.repeat(40),
        sourceTree: 'd'.repeat(40),
      },
    };
  }
  async function prepareCloud(
    c: Awaited<ReturnType<typeof seed>>,
    credential?: Awaited<ReturnType<typeof cloudCredential>>,
  ) {
    const proof = credential ?? (await cloudCredential(c));
    const p = await prepareNativeScheduleControlUpgrade({
      db,
      requestId: proof.observation.planId,
      partitionId: c.partitionId,
      beforeReference: c.before,
      afterReference: c.after,
      artifactEvidence: evidence(c.before, c.after),
      historicalCloudAbsenceCredential: proof,
    });
    const auth = await authorize(p);
    auth.offlineStoppedAttestation.locks = proof.observation.locks;
    auth.offlineStoppedAttestation.processes = proof.observation
      .processes as NativeControlOfflineStoppedAttestation['processes'];
    auth.approval.attestationDigest = nativeOnceDigest(
      auth.offlineStoppedAttestation,
    );
    return { p, auth, proof };
  }
  it('historical cloud absence: missing proof and rootReviewed JSON retain the original raw guard', async () => {
    await seedHistoricalCloud();
    const c = await seed();
    const [raw] = await db`select allrice_native_control_upgrade_idle() counts`;
    expect(raw!.counts.clouds).toBe(1);
    await expect(prepare(c)).rejects.toThrow('not_idle');
    await expect(
      prepareNativeScheduleControlUpgrade({
        db,
        requestId: randomUUID(),
        partitionId: c.partitionId,
        beforeReference: c.before,
        afterReference: c.after,
        artifactEvidence: evidence(c.before, c.after),
        historicalCloudAbsenceCredential: { rootReviewed: true },
      }),
    ).rejects.toThrow();
    const [n] =
      await db`select count(*)::int n from allrice_native_control_cloud_absences`;
    expect(n!.n).toBe(0);
  });
  it.each(['allrice-once-control-v1', 'allrice-recurring-control-v1'] as const)(
    'historical cloud absence: exact %s plan/apply preserves unknown and every original row',
    async (profile) => {
      const c = await seed(profile),
        before = await cloudSnapshot(),
        { p, auth } = await prepareCloud(c);
      const [counts] =
        await db`select allrice_native_control_cloud_coverage(${db.json(p.plan)}) v,allrice_native_control_upgrade_idle() raw`;
      expect(counts!.v).toMatchObject({
        rawUncleanedCloudAttempts: 1,
        preservedUnresolvedCloudAttempts: 1,
        unpreservedCloudAttempts: 0,
        historicalOutcomeKnown: false,
        cleanupClaimed: false,
      });
      expect(counts!.raw.clouds).toBe(1);
      await apply(p, auth);
      expect((await row(c.partitionId)).reference).toEqual(c.after);
      expect(await cloudSnapshot()).toEqual(before);
      expect(
        await readNativeScheduleControlUpgrade({
          db,
          planId: p.plan.planId,
          expected: expected(p, auth),
        }),
      ).toMatchObject({ status: 'applied' });
      for (const statement of [
        db`update allrice_native_control_cloud_absences set credential=credential where plan_id=${p.plan.planId}`,
        db`delete from allrice_native_control_cloud_absences where plan_id=${p.plan.planId}`,
      ])
        await expect(statement).rejects.toThrow('immutable');
    },
  );
  it.each([
    'tuple',
    'original byte',
    'new attempt',
    'live lease',
    'receipt',
  ] as const)(
    'historical cloud absence: actual COMMIT rejects %s changes and rolls back original history',
    async (change) => {
      const c = await seed(),
        before = await cloudSnapshot(),
        { p, auth } = await prepareCloud(c),
        original = await row(c.partitionId);
      const fenced = {
        begin: (options: string, work: (tx: unknown) => Promise<unknown>) =>
          db.begin(options, async (tx) => {
            const result = await work(tx);
            if (change === 'tuple')
              await tx`update allrice_native_recurring_controls set snapshot_version=snapshot_version+1,snapshot=snapshot||'{"newByte":true}' where partition_id=${c.partitionId}`;
            if (change === 'original byte')
              await tx`update allrice_cloud_execution_attempts set lease_token='a changed original byte' where operation_id=${cloudOperation}`;
            if (change === 'live lease')
              await tx`update allrice_runtime_operations set lease_expires_at=clock_timestamp()+interval '1 minute' where id=${cloudOperation}`;
            if (change === 'receipt')
              await tx`insert into allrice_runtime_operation_receipts(receipt_id,operation_id,payload,disposition) values(${randomUUID()},${cloudOperation},'{}','stale')`;
            if (change === 'new attempt') {
              const operation = randomUUID();
              await tx`insert into allrice_runtime_operations(id,organization_id,workspace_id,run_id,root_run_id,target_id,attempt_id,attempt_number,generation,fence,idempotency_key,initial_snapshot,snapshot)
          values(${operation},${org},${workspace},${cloudRun},${cloudRun},${cloudTarget},${randomUUID()},1,1,1,${randomUUID()},'{"status":"unknown"}','{"status":"unknown"}')`;
              await tx`insert into allrice_cloud_execution_attempts(operation_id,lease_token) values(${operation},'synthetic-new-active')`;
            }
            return result;
          }),
      } as unknown as Sql;
      await expect(apply(p, auth, fenced)).rejects.toThrow(
        'commit_unknown_readback_only',
      );
      expect(await row(c.partitionId)).toEqual(original);
      expect(await cloudSnapshot()).toEqual(before);
      expect(
        await readNativeScheduleControlUpgrade({
          db,
          planId: p.plan.planId,
          expected: expected(p, auth),
        }),
      ).toMatchObject({ status: 'not_applied' });
    },
  );
  it('historical cloud absence: changed lock scope and expired credential cannot reuse the reviewed exception', async () => {
    const c = await seed(),
      { p, auth } = await prepareCloud(c);
    auth.offlineStoppedAttestation.locks[0]!.tokenDigest =
      pin('changed owner lock');
    auth.approval.attestationDigest = nativeOnceDigest(
      auth.offlineStoppedAttestation,
    );
    await expect(apply(p, auth)).rejects.toThrow('not_idle');
    const next = await seed(),
      short = await cloudCredential(next, 1000),
      x = await prepareCloud(next, short);
    const expired = {
      begin: (options: string, work: (tx: unknown) => Promise<unknown>) =>
        db.begin(options, async (tx) => {
          const result = await work(tx);
          await tx`select pg_sleep(1.1)`;
          return result;
        }),
    } as unknown as Sql;
    await expect(apply(x.p, x.auth, expired)).rejects.toThrow(
      'commit_unknown_readback_only',
    );
    expect((await row(next.partitionId)).reference).toEqual(next.before);
  });
  it('historical cloud absence: lost actual COMMIT acknowledgement is resolved by independent exact readback', async () => {
    const c = await seed(),
      { p, auth } = await prepareCloud(c),
      before = await cloudSnapshot();
    const lost = {
      begin: async (
        options: string,
        work: (tx: unknown) => Promise<unknown>,
      ) => {
        await db.begin(options, work as never);
        throw Error('synthetic lost original commit ACK');
      },
    } as unknown as Sql;
    await expect(apply(p, auth, lost)).rejects.toThrow(
      'commit_unknown_readback_only',
    );
    expect(
      await readNativeScheduleControlUpgrade({
        db,
        planId: p.plan.planId,
        expected: expected(p, auth),
      }),
    ).toMatchObject({ status: 'applied' });
    expect(await cloudSnapshot()).toEqual(before);
    await expect(apply(p, auth)).rejects.toThrow(
      'already_applied_readback_only',
    );
  });
  it('historical cloud absence: a credential cannot commit without its exact plan FK', async () => {
    const c = await seed(),
      proof = await cloudCredential(c),
      digest = nativeOnceDigest(proof);
    await expect(db`insert into allrice_native_control_cloud_absences(plan_id,partition_id,credential_digest,before_reference,after_reference,credential)
      values(${proof.observation.planId},${c.partitionId},${digest},${db.json({ ...c.before })},${db.json(c.after)},${db.json(JSON.parse(JSON.stringify(proof)))})`).rejects.toThrow(
      'foreign key',
    );
    expect(
      (
        await db`select 1 from allrice_native_control_cloud_absences where plan_id=${proof.observation.planId}`
      ).length,
    ).toBe(0);
  });
  it('historical cloud absence: an altered target cannot reuse the original physical credential', async () => {
    const c = await seed(),
      proof = await cloudCredential(c);
    proof.observation.afterReference = {
      ...proof.observation.afterReference,
      storageId: 'a different target',
    };
    proof.approval.observationDigest = nativeOnceDigest(proof.observation);
    await expect(prepareCloud(c, proof)).rejects.toThrow('credential rejected');
    expect((await row(c.partitionId)).reference).toEqual(c.before);
  });
  it('historical cloud absence: prepared credential and plan survive a lost COMMIT receipt together', async () => {
    const c = await seed(),
      proof = await cloudCredential(c),
      before = await cloudSnapshot();
    const lost = {
      begin: async (
        options: string,
        work: (tx: unknown) => Promise<unknown>,
      ) => {
        await db.begin(options, work as never);
        throw Error('synthetic lost prepare COMMIT receipt');
      },
    } as unknown as Sql;
    await expect(
      prepareNativeScheduleControlUpgrade({
        db: lost,
        requestId: proof.observation.planId,
        partitionId: c.partitionId,
        beforeReference: c.before,
        afterReference: c.after,
        artifactEvidence: evidence(c.before, c.after),
        historicalCloudAbsenceCredential: proof,
      }),
    ).rejects.toThrow('lost prepare COMMIT receipt');
    const read = await readNativeScheduleControlUpgrade({
      db,
      planId: proof.observation.planId,
    });
    expect(read).toMatchObject({
      status: 'plan_only',
      plan: { historicalCloudAbsenceDigest: nativeOnceDigest(proof) },
    });
    expect(await cloudSnapshot()).toEqual(before);
    expect(
      (
        await db`select credential_digest from allrice_native_control_cloud_absences where plan_id=${proof.observation.planId}`
      )[0]!.credential_digest,
    ).toBe(nativeOnceDigest(proof));
  });
});
