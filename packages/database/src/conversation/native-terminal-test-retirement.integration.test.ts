/** Real private-schema SQL only. Synthetic physical proofs exercise the SQL
 * boundary and never claim an OS/Native observation or a real Dev retirement. */
import { randomUUID, createHash } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from '../core/client.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from '../assistant-runtime.fixture.ts';
import { createExperienceFixture } from '../experience.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { verifyNativeArtifactReferenceCoverage } from './native-artifact-references.ts';
import { nativeRootDigest, nativeRootSeed } from './native-root-origin.ts';
import {
  previewNativeTerminalTestRetirement as preview,
  applyNativeTerminalTestRetirement as apply,
  readNativeTerminalTestRetirement as readback,
  nativeTerminalTestPhysicalScope,
  readVerifiedNativeTerminalTestRetirements,
  type NativeTerminalTestScope,
  type NativeTerminalTestPlan,
} from './native-terminal-test-retirement.ts';
import { readVerifiedNativeChatRetirements } from './native-context-retirement.ts';
import {
  reserveDshRuntimeOwner,
  recordDshRuntimeCloseObservation,
  type DshRuntimeOwnedObservation,
} from '../providers/dsh-runtime-close-observations.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const digest = (s: string) =>
  'sha256:' + createHash('sha256').update(s).digest('hex');
suite(
  'terminal nonchat development discard: retained history, atomic cutoff / no Host',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let admin: Awaited<ReturnType<typeof createEmployeeAdministrationFixture>>;
    let port: typeof f.db;
    beforeAll(async () => {
      f = await createAssistantFixtureDatabase({ ownSchemaOnly: true });
      port = f.db;
      vi.spyOn(client, 'getDatabase').mockImplementation(() => port);
      const [where] =
        await f.db`select current_database() db,current_schema() schema,current_setting('search_path') path`;
      expect(where!.db).toBe(
        decodeURIComponent(
          new URL(process.env.ALLRICE_TEST_DATABASE_URL!).pathname.slice(1),
        ),
      );
      expect(where!.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      expect(where!.path).toBe(where!.schema);
      admin = await createEmployeeAdministrationFixture(f.db);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (f) {
        const cleanup = await f.close();
        console.info('TERMINAL_SQL_CLEANUP', JSON.stringify(cleanup));
        for (const k of [
          'schemaRemoved',
          'storageRemoved',
          'databaseClosed',
          'adminClosed',
        ] as const)
          expect(cleanup[k]).toBe(true);
      }
    }, 30000);
    function scope(
      kind: NativeTerminalTestScope['contextKind'],
      id: string = randomUUID(),
    ): NativeTerminalTestScope {
      return {
        contextKind: kind,
        contextId: id,
        organizationId: admin.organizationId,
        workspaceId: admin.workspaceId,
        ownerId: admin.ownerId,
      };
    }
    const request = (scopes: NativeTerminalTestScope[]) => ({
      requestId: randomUUID(),
      authorizationEvidenceDigest: digest(
        'Synthetic dedicated-schema explicit discard',
      ),
      scopes,
    });
    async function roots(s: NativeTerminalTestScope) {
      const run = randomUUID(),
        job = randomUUID();
      const spec =
        s.contextKind === 'platform_employee_test'
          ? {
              handler: 'platform_employee_preview',
              platformEmployeeTestRunId: s.contextId,
            }
          : {};
      await f.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,completed_at,execution_spec,input) values(${run},${s.organizationId},${s.workspaceId},${s.ownerId},'succeeded',clock_timestamp(),${f.db.json(spec)},'{}')`;
      await f.db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,completed_at) values(${job},${s.organizationId},${s.workspaceId},${s.ownerId},${run},'succeeded',${job},clock_timestamp()+interval '1 hour','{}',clock_timestamp())`;
      await f.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload) values(${s.organizationId},${s.workspaceId},${run},0,'run.succeeded','{"syntheticHistory":"retained"}')`;
      return { run, job };
    }
    async function subject(
      kind: NativeTerminalTestScope['contextKind'] = 'platform_employee_test',
      pins = 1,
    ) {
      let s = scope(kind);
      if (kind === 'experience_consolidation') {
        const c = await createExperienceFixture(f.db);
        s = {
          ...s,
          organizationId: c.org,
          workspaceId: c.workspace,
          ownerId: c.user,
        };
      }
      if (kind === 'platform_employee_test') {
        // A true NULL/V1 historical INSERT: no V2 identity is changed after birth.
        await f.db`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,output,completed_at) values(${s.contextId},${admin.employeeId},${admin.revisionId},'Synthetic disposable history','succeeded','{}','{"answer":"independent retained result"}',clock_timestamp())`;
      }
      const { run, job } = await roots(s);
      if (kind === 'platform_technical')
        await f.db`insert into allrice_platform_technical_tasks(id,request_id,owner_id,organization_id,workspace_id,run_id,job_id,environment,input_digest,frozen_configuration,native_root_origin) values(${s.contextId},${randomUUID()},${s.ownerId},${s.organizationId},${s.workspaceId},${run},${job},'test',${digest('Synthetic technical history')},'{"question":"retained diagnosis"}',${f.db.json({ schemaVersion: 1, contextKind: 'platform_technical', contextId: s.contextId, rootSeed: nativeRootSeed('platform_technical', s.contextId), artifactId: digest('Synthetic V1 internal origin'), distributionGeneration: 'dsh-0.2.1-rc.2-687f282', profileId: 'technical', frozenIdentity: { kind: 'internal_recipe', checksum: nativeRootDigest({}) } })})`;
      if (kind === 'experience_consolidation') {
        const automation = randomUUID();
        const [assignment] =
          await f.db`select id from allrice_employee_assignments where organization_id=${s.organizationId} and workspace_id=${s.workspaceId} and user_id=${s.ownerId} limit 1`;
        // This is unbound historical SQL, not a fabricated native schedule delivery.
        await f.db`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,schedule,status,conversation_mode,experience_binding,employee_assignment_id) values(${automation},${s.organizationId},${s.workspaceId},${s.ownerId},'Synthetic retained experience rule','history','{"frequency":"daily","timezone":"Asia/Shanghai","time":"01:00"}','paused','new_each_run',${f.db.json({ schemaVersion: 1, instanceId: randomUUID(), policyDigest: digest('history') })},${assignment?.id ?? null})`;
        await f.db`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,run_id,status,scheduled_for,completed_at,experience_occurrence,experience_validation_plan,experience_adoption_plan) values(${s.contextId},${s.organizationId},${s.workspaceId},${automation},${run},'succeeded',clock_timestamp(),clock_timestamp(),${f.db.json({ ownerId: s.ownerId, history: 'synthetic unbound occurrence' })},'[]','{"status":"complete","pendingDrafts":[],"drafts":[]}')`;
      }
      const artifacts: string[] = [];
      for (let i = 0; i < pins; i++) {
        const artifact = digest(randomUUID());
        artifacts.push(artifact);
        await pin(s, run, job, artifact);
      }
      return { s, run, job, artifacts };
    }
    async function pin(
      s: NativeTerminalTestScope,
      run: string,
      job: string,
      artifact: string,
    ) {
      await f.db`insert into allrice_native_session_bindings(native_session_id,organization_id,workspace_id,owner_id,context_kind,context_id,storage_context_key,storage_namespace,artifact_id,artifact_manifest_digest,distribution_generation,profile_id,first_run_id,first_job_id,first_attempt,binding_basis) values(${'dsh-' + randomUUID()},${s.organizationId},${s.workspaceId},${s.ownerId},${s.contextKind},${s.contextId},${s.contextId},${f.storageRoot + '/' + s.contextId + '/' + artifact.slice(7)},${artifact},${artifact},'synthetic-history','restricted',${run},${job},1,'approved_compatibility_reader')`;
    }
    const planFor = async (s: NativeTerminalTestScope) => preview(request([s]));
    function proof(p: NativeTerminalTestPlan) {
      const physical = nativeTerminalTestPhysicalScope(p);
      return {
        kind: 'terminal-native-physical-absence-v1',
        requestId: p.requestId,
        planDigest: p.digest,
        scopeDigest: physical.digest,
        workerBootId: randomUUID(),
        workerBootStartedAt: new Date().toISOString(),
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 90000).toISOString(),
        processInventoryDigest: digest('Synthetic ps only'),
        writerInventoryDigest: digest('Synthetic lsof only'),
        nativeProcesses: [],
        writers: [],
        artifactRoots: physical.artifactIds.map((artifactId) => ({
          artifactId,
          root: f.storageRoot!,
          manifestSha256: 'a'.repeat(64),
        })),
        storageNamespaces: physical.storageNamespaces,
        writerScopes: physical.artifactIds.map((artifactId) => ({
          artifactId,
          root: f.storageRoot!,
        })),
        evidencePath: f.storageRoot! + '/synthetic-proof.json',
        evidenceSha256: 'e'.repeat(64),
        sourceSha: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
        operatorSha256: 'c'.repeat(64),
        reviewSha256: 'd'.repeat(64),
      };
    }
    const applyPlan = (p: NativeTerminalTestPlan) =>
      apply({ plan: p, physicalProof: proof(p) });
    async function history(s: NativeTerminalTestScope) {
      const [row] =
        await f.db`select allrice_terminal_native_test_facts(${s.contextKind},${s.contextId},${s.organizationId},${s.workspaceId},${s.ownerId}) facts`;
      return row!.facts;
    }

    async function holdCutoff(p: NativeTerminalTestPlan) {
      let reached!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => (reached = r)),
        gate = new Promise<void>((r) => (release = r));
      port = new Proxy(f.db, {
        get(target, k, receiver) {
          if (k !== 'begin') return Reflect.get(target, k, receiver);
          return async (
            callback: (tx: postgres.TransactionSql) => Promise<unknown>,
          ) =>
            target.begin(async (tx) => {
              const result = await callback(tx);
              reached();
              await gate;
              return result;
            });
        },
      }) as typeof f.db;
      const result = applyPlan(p);
      try {
        await Promise.race([
          ready,
          result.then(() => {
            throw Error('cutoff did not pause');
          }),
        ]);
      } finally {
        port = f.db;
      }
      return { result, release };
    }
    async function waitForAdvisory(tag: string, events = ['advisory']) {
      for (let i = 0; i < 100; i++) {
        const [row] =
          await f.db`select pid,backend_start,state,wait_event_type,wait_event from pg_stat_activity where datname=current_database() and application_name=${tag}`;
        if (
          row?.wait_event_type === 'Lock' &&
          events.includes(row.wait_event)
        ) {
          console.info(
            'TERMINAL_SQL_PENDING_WITNESS',
            JSON.stringify({ tag, ...row }),
          );
          return;
        }
      }
      throw Error(
        'Pending writer was not observed waiting on the real cutoff lock',
      );
    }
    it('only a verified exact cutoff removes references; a cloned origin on another source remains protected', async () => {
      const t = await subject('platform_technical', 2),
        p = await planFor(t.s);
      await applyPlan(p);
      const approvals = [
        {
          artifactId: digest('unreferenced synthetic approved runtime'),
          generation: 'dsh-0.2.1-rc.2-687f282' as const,
          storageRoot: f.storageRoot!,
        },
      ];
      expect(
        (await verifyNativeArtifactReferenceCoverage(approvals)).verified,
      ).toBe(true);
      const other = scope('platform_technical'),
        r = await roots(other);
      await f.db`insert into allrice_platform_technical_tasks select (jsonb_populate_record(null::allrice_platform_technical_tasks,to_jsonb(t)||${f.db.json({ id: other.contextId, request_id: randomUUID(), run_id: r.run, job_id: r.job })})).* from allrice_platform_technical_tasks t where id=${t.s.contextId}`;
      await expect(
        verifyNativeArtifactReferenceCoverage(approvals),
      ).rejects.toThrow(/REFERENCES_UNCOVERED/);
    });
    for (const kind of [
      'platform_employee_test',
      'experience_consolidation',
      'platform_technical',
    ] as const)
      it(`retains ${kind} source/all bindings/Run/events while making execution terminal`, async () => {
        const t = await subject(kind, 2),
          before = await history(t.s),
          p = await planFor(t.s);
        const originalAccounts =
          await f.db`select to_jsonb(u) row from allrice_users u where id=${t.s.ownerId}`;
        const result = await applyPlan(p);
        expect(result.alreadyApplied).toBe(false);
        expect(result.historicalClosure).toBe('not_reclassified');
        expect(await history(t.s)).toEqual(before);
        expect(
          await f.db`select to_jsonb(u) row from allrice_users u where id=${t.s.ownerId}`,
        ).toEqual(originalAccounts);
        const again = await apply({ plan: p, physicalProof: null });
        expect(again.alreadyApplied).toBe(true);
        expect(again.contexts).toEqual(result.contexts);
        expect((await readback(p)).status).toBe('completed');
        await expect(
          f.db`update allrice_runs set state='queued',completed_at=null where id=${t.run}`,
        ).rejects.toThrow(/RETIRED/);
        await expect(
          f.db`update allrice_jobs set status='retry_wait',completed_at=null where id=${t.job}`,
        ).rejects.toThrow(/RETIRED/);
        await expect(
          pin(t.s, t.run, t.job, digest(randomUUID())),
        ).rejects.toThrow(/retired/i);
        await expect(
          f.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type) values(${t.s.organizationId},${t.s.workspaceId},${t.run},1,'heartbeat')`,
        ).rejects.toThrow(/RETIRED/);
        expect(
          (
            await f.db.begin(
              'read only',
              readVerifiedNativeTerminalTestRetirements,
            )
          ).some((x) => x.contextId === t.s.contextId),
        ).toBe(true);
        expect(
          await f.db.begin('read only', readVerifiedNativeChatRetirements),
        ).toEqual([]);
      });
    it('supports an actual current V2 admin preview without rewriting its immutable definition/execution origin', async () => {
      const made = await admin.preview(),
        s = scope('platform_employee_test', made.id),
        p = await planFor(s);
      expect(p.snapshots[0]!.origin?.schemaVersion).toBe(2);
      const before = await history(s);
      await applyPlan(p);
      expect(await history(s)).toEqual(before);
    });
    it('requires proof of every historical binding artifact and namespace, not one closed owner', async () => {
      const t = await subject('platform_employee_test', 2),
        p = await planFor(t.s),
        e = proof(p);
      expect(e.artifactRoots).toHaveLength(2);
      expect(e.storageNamespaces).toHaveLength(2);
      e.artifactRoots.pop();
      await expect(apply({ plan: p, physicalProof: e })).rejects.toThrow(
        /PHYSICAL_PROOF_CHANGED/,
      );
      await expect(
        apply({ plan: p, physicalProof: { rootReviewed: true } }),
      ).rejects.toThrow();
      expect((await readback(p)).status).toBe('not-found');
    });
    it.each(['nativeProcesses', 'writers', 'expiresAt'] as const)(
      'SQL keeps %s absence/TTL strict even with a submitted exited-container review',
      async (field) => {
        const t = await subject(),
          p = await planFor(t.s),
          e = proof(p);
        const claimed = {
          ...e,
          rootReviewed: true,
          cloudPreservation: {
            kind: 'allrice-dev-terminal-nonchat-exact-exited-container-v1',
            enabled: true,
            rootReviewed: true,
            containerId:
              'c059c14ced1dcd6664c7131382a5ef0975c7c6ce1245932892dd921c45a070be',
          },
        } as Record<string, unknown>;
        if (field === 'expiresAt')
          claimed.expiresAt = '2000-01-01T00:00:00.000Z';
        else
          claimed[field] = [
            { pid: 123, purpose: 'Synthetic writer; never launched' },
          ];
        const snapshot = p.snapshots[0]!,
          scope = snapshot.scope;
        await expect(f.db`insert into allrice_native_context_retirements
          (context_kind,context_id,organization_id,workspace_id,owner_id,request_id,plan_digest,reason,
            origin_snapshot,binding_snapshot,preservation_snapshot,authorization_evidence_digest)
          values(${scope.contextKind},${scope.contextId},${scope.organizationId},${scope.workspaceId},${scope.ownerId},
            ${p.requestId},${p.digest},'development_test_discarded',
            ${snapshot.origin ? f.db.json(JSON.parse(JSON.stringify(snapshot.origin))) : null},
            ${f.db.json(snapshot.bindings)},${f.db.json(JSON.parse(JSON.stringify({ kind: 'development-terminal-test-retirement-v1', facts: snapshot, physicalProof: claimed })))},
            ${p.authorizationEvidenceDigest})`).rejects.toThrow(
          'NATIVE_TERMINAL_RETIREMENT_PROOF_INVALID',
        );
        expect((await readback(p)).status).toBe('not-found');
        expect(await history(t.s)).toEqual(snapshot);
      },
    );
    it('rejects stale source and exact binding-set changes', async () => {
      const t = await subject(),
        p = await planFor(t.s);
      await pin(t.s, t.run, t.job, digest(randomUUID()));
      await expect(applyPlan(p)).rejects.toThrow(/PLAN_STALE/);
      expect((await readback(p)).status).toBe('not-found');
    });
    it('refuses queued/retry/running execution and owner/tenant substitution', async () => {
      const t = await subject();
      await f.db`update allrice_jobs set status='retry_wait',completed_at=null where id=${t.job}`;
      await expect(planFor(t.s)).rejects.toThrow(/CONTEXT_BUSY/);
      await f.db`update allrice_jobs set status='succeeded',completed_at=clock_timestamp() where id=${t.job}`;
      await expect(
        preview(request([{ ...t.s, ownerId: randomUUID() }])),
      ).rejects.toThrow(/SCOPE_CONFLICT/);
    });
    it('does not infer closure for a registered unconfirmed context or provider owner', async () => {
      for (const provider of [false, true]) {
        const t = await subject(),
          p = await planFor(t.s);
        const o: DshRuntimeOwnedObservation = {
          version: 1,
          kind: 'owned',
          runtimeId: randomUUID(),
          workerBootId: randomUUID(),
          workerId: randomUUID(),
          serviceManifestDigest: digest('Synthetic worker'),
          artifactId: t.artifacts[0]!,
          profileId: 'restricted',
          context: provider
            ? { kind: 'provider', purpose: 'codex_search' }
            : { kind: 'context', ...t.s },
          observedAt: new Date().toISOString(),
        };
        await reserveDshRuntimeOwner(o);
        await expect(applyPlan(p)).rejects.toThrow(
          /REGISTERED_OWNER_UNCONFIRMED|PLAN_STALE/,
        );
        await recordDshRuntimeCloseObservation(
          { owner: o, ownerDigest: nativeRootDigest(o) },
          {
            version: 1,
            kind: 'process_closed',
            runtimeId: o.runtimeId,
            workerBootId: o.workerBootId,
            ownerDigest: nativeRootDigest(o),
            observedAt: new Date().toISOString(),
            fact: {
              source: 'child_close',
              stdioClosed: true,
              exitCode: 0,
              signal: null,
              terminationAttempted: null,
            },
          },
        );
        await expect(applyPlan(p)).rejects.toThrow(
          /REGISTERED_OWNER_UNCONFIRMED|PLAN_STALE/,
        );
      }
    });
    it('accepts never-spawned only as the existing recorded fact, preserving every row', async () => {
      const t = await subject();
      const o: DshRuntimeOwnedObservation = {
        version: 1,
        kind: 'owned',
        runtimeId: randomUUID(),
        workerBootId: randomUUID(),
        workerId: randomUUID(),
        serviceManifestDigest: digest('Synthetic worker'),
        artifactId: t.artifacts[0]!,
        profileId: 'restricted',
        context: { kind: 'context', ...t.s },
        observedAt: new Date().toISOString(),
      };
      await reserveDshRuntimeOwner(o);
      await recordDshRuntimeCloseObservation(
        { owner: o, ownerDigest: nativeRootDigest(o) },
        {
          version: 1,
          kind: 'process_closed',
          runtimeId: o.runtimeId,
          workerBootId: o.workerBootId,
          ownerDigest: nativeRootDigest(o),
          observedAt: new Date().toISOString(),
          fact: {
            source: 'never_spawned',
            spawnAttempted: false,
            reason: 'admission_closed_before_spawn',
          },
        },
      );
      const p = await planFor(t.s);
      expect(p.snapshots[0]!.closeRows).toHaveLength(2);
      await applyPlan(p);
      expect(await history(t.s)).toEqual(p.snapshots[0]);
    });
    it('returns original facts after a lost COMMIT receipt; independent readback never replays', async () => {
      const t = await subject(),
        p = await planFor(t.s);
      let writes = 0;
      port = new Proxy(f.db, {
        get(target, k, receiver) {
          if (k !== 'begin') return Reflect.get(target, k, receiver);
          return async (...args: unknown[]) => {
            writes++;
            await Reflect.apply(target.begin, target, args);
            throw Error('synthetic lost COMMIT receipt');
          };
        },
      }) as typeof f.db;
      try {
        await expect(applyPlan(p)).rejects.toThrow(
          'synthetic lost COMMIT receipt',
        );
      } finally {
        port = f.db;
      }
      expect(writes).toBe(1);
      expect((await readback(p)).status).toBe('completed');
      expect((await readback(p)).status).toBe('completed');
      expect(
        await f.db`select * from allrice_native_context_retirements where request_id=${p.requestId}`,
      ).toHaveLength(1);
    });
    it('rejects conflicting reuse of a request and never rewrites the first receipt', async () => {
      const a = await subject(),
        b = await subject(),
        p = await planFor(a.s);
      await applyPlan(p);
      const q = await preview({ ...request([b.s]), requestId: p.requestId });
      await expect(applyPlan(q)).rejects.toThrow(/REQUEST_CONFLICT/);
    });
    it('protects the real PPT UUID and refuses technical Prod scopes', async () => {
      await expect(
        preview(
          request([
            scope(
              'platform_employee_test',
              '68e76b6b-2e75-45b7-b628-951945b12044',
            ),
          ]),
        ),
      ).rejects.toThrow();
      const t = await subject('platform_technical');
      await f.db`update allrice_platform_technical_tasks set environment='prod' where id=${t.s.contextId}`;
      await expect(planFor(t.s)).rejects.toThrow(/NOT_DEVELOPMENT/);
    });
    it('append-only retirement and deferred exact snapshot reject direct malformed SQL', async () => {
      const t = await subject(),
        p = await planFor(t.s);
      await applyPlan(p);
      await expect(
        f.db`delete from allrice_native_context_retirements where context_id=${t.s.contextId}`,
      ).rejects.toThrow(/terminal/);
      const u = await subject();
      await expect(
        f.db`insert into allrice_native_context_retirements(context_kind,context_id,organization_id,workspace_id,owner_id,request_id,plan_digest,reason,binding_snapshot,preservation_snapshot,authorization_evidence_digest) values(${u.s.contextKind},${u.s.contextId},${u.s.organizationId},${u.s.workspaceId},${u.s.ownerId},${randomUUID()},${digest('bad')},'development_test_discarded','[]','{"rootReviewed":true}',${digest('bad')})`,
      ).rejects.toThrow(/PROOF_INVALID/);
    });
    it('a source-first finalizer and queue writer cannot deadlock the NOWAIT cutoff', async () => {
      const t = await subject(),
        p = await planFor(t.s);
      let reached!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => (reached = r)),
        gate = new Promise<void>((r) => (release = r));
      const writer = f.db.begin(async (tx) => {
        await tx`select id from allrice_platform_employee_test_runs where id=${t.s.contextId} for no key update`;
        reached();
        await gate;
        await tx`update allrice_runs set updated_at=clock_timestamp() where id=${t.run}`;
      });
      try {
        await ready;
        await expect(applyPlan(p)).rejects.toThrow(
          /could not obtain lock|CUTOFF_BUSY/,
        );
      } finally {
        release();
        await writer;
      }
      expect((await readback(p)).status).toBe('not-found');
    });
    it('a writer captured before COMMIT cannot insert a binding after the cutoff', async () => {
      const t = await subject(),
        p = await planFor(t.s),
        held = await holdCutoff(p),
        tag = 'terminal-pending-binding:' + randomUUID();
      const late = f.db
        .begin(async (tx) => {
          await tx`select set_config('application_name',${tag},true)`;
          await tx`insert into allrice_native_session_bindings select (jsonb_populate_record(null::allrice_native_session_bindings,to_jsonb(b)||jsonb_build_object('native_session_id',${'dsh-' + randomUUID()}::text,'bound_at',clock_timestamp()))).* from allrice_native_session_bindings b where b.context_kind=${t.s.contextKind} and b.context_id=${t.s.contextId}`;
        })
        .then(
          () => ({ accepted: true }),
          (error) => ({ accepted: false, error }),
        );
      try {
        await waitForAdvisory(tag);
      } finally {
        held.release();
        await held.result;
      }
      expect(await late).toMatchObject({
        accepted: false,
        error: { message: expect.stringMatching(/retired/i) },
      });
      expect((await readback(p)).status).toBe('completed');
      expect((await history(t.s)).bindings).toHaveLength(1);
    });
    it('completed experience consumers stay readable; pending adoption and late validation cannot run', async () => {
      const t = await subject('experience_consolidation'),
        p = await planFor(t.s);
      await applyPlan(p);
      await expect(
        f.db`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,purpose,experience_binding) values(${randomUUID()},${admin.employeeId},${admin.revisionId},'Synthetic late consumer','queued','{}','experience_validation',${f.db.json({ schemaVersion: 1, occurrenceId: t.s.contextId, organizationId: t.s.organizationId, workspaceId: t.s.workspaceId, ownerId: t.s.ownerId, draftIndex: 0 })})`,
      ).rejects.toThrow(/RETIRED/);
      const u = await subject('experience_consolidation');
      await f.db`update allrice_automation_runs set experience_adoption_plan='{"status":"awaiting_validation","pendingDrafts":[0],"drafts":[]}' where id=${u.s.contextId}`;
      await expect(planFor(u.s)).rejects.toThrow(/CONSUMER_BUSY/);
      expect(
        (
          await f.db`select experience_occurrence,experience_adoption_plan from allrice_automation_runs where id=${t.s.contextId}`
        )[0]!.experience_occurrence,
      ).toEqual(p.snapshots[0]!.source.experience_occurrence);
    });
    it('retained experience consumer identity stays immutable across cutoff', async () => {
      const t = await subject('experience_consolidation'),
        consumer = randomUUID();
      await f.db`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,purpose,experience_binding,completed_at) values(${consumer},${admin.employeeId},${admin.revisionId},'Synthetic completed consumer','succeeded','{}','experience_validation',${f.db.json({ schemaVersion: 1, occurrenceId: t.s.contextId, organizationId: t.s.organizationId, workspaceId: t.s.workspaceId, ownerId: t.s.ownerId, draftIndex: 0 })},clock_timestamp())`;
      const p = await planFor(t.s);
      expect(p.snapshots[0]!.consumers).toHaveLength(1);
      await applyPlan(p);
      await expect(
        f.db`update allrice_platform_employee_test_runs set experience_binding=null,purpose='platform_preview' where id=${consumer}`,
      ).rejects.toThrow(
        'experience validation identity and result are immutable',
      );
      expect((await readback(p)).status).toBe('completed');
      expect((await history(t.s)).consumers).toEqual(p.snapshots[0]!.consumers);
    });
    it('keeps a missing first Job unknown and rejects a future reuse of that ID', async () => {
      const t = await subject(),
        artifact = digest(randomUUID()),
        missing = randomUUID();
      await pin(t.s, t.run, missing, artifact);
      const p = await planFor(t.s);
      expect(p.snapshots[0]!.missingJobIds).toEqual([missing]);
      await applyPlan(p);
      const other = await subject();
      await expect(
        f.db`update allrice_jobs set id=${missing} where id=${other.job}`,
      ).rejects.toThrow(/RETIRED/);
      expect(
        await f.db`select id from allrice_jobs where id=${missing}`,
      ).toHaveLength(0);
      expect((await readback(p)).status).toBe('completed');
      expect((await history(t.s)).missingJobIds).toEqual([missing]);
    });
    it('retains an absent original Run as unknown and cannot recreate that Run through a pending INSERT', async () => {
      const t = await subject(),
        missingRun = randomUUID(),
        missingJob = randomUUID();
      await pin(t.s, missingRun, missingJob, digest(randomUUID()));
      const p = await planFor(t.s);
      expect(p.snapshots[0]!.missingRunIds).toEqual([missingRun]);
      const held = await holdCutoff(p),
        tag = 'terminal-pending-run:' + randomUUID();
      const late = f.db
        .begin(async (tx) => {
          await tx`select set_config('application_name',${tag},true)`;
          await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec) values(${missingRun},${t.s.organizationId},${t.s.workspaceId},${t.s.ownerId},'queued','{}')`;
        })
        .then(
          () => ({ accepted: true }),
          (error) => ({ accepted: false, error }),
        );
      try {
        await waitForAdvisory(tag);
      } finally {
        held.release();
        await held.result;
      }
      expect(await late).toMatchObject({
        accepted: false,
        error: { message: expect.stringMatching(/retired/i) },
      });
      expect(
        await f.db`select id from allrice_runs where id=${missingRun}`,
      ).toHaveLength(0);
      expect((await history(t.s)).missingRunIds).toEqual([missingRun]);
      expect((await readback(p)).status).toBe('completed');
    });
    it('preserves an independent immutable file and its readable bytes', async () => {
      const t = await subject(),
        id = randomUUID(),
        text = 'Synthetic independent company result survives test discard.';
      const object = {
        id,
        organizationId: t.s.organizationId,
        workspaceId: t.s.workspaceId,
        ownerId: t.s.ownerId,
        key: `organizations/${t.s.organizationId}/workspaces/${t.s.workspaceId}/owners/${t.s.ownerId}/artifacts/${id}`,
        checksum: digest(text),
        sizeBytes: Buffer.byteLength(text),
        mediaType: 'text/plain',
        retentionUntil: null,
        deletedAt: null,
        immutable: true,
      };
      const storage = assistantFixtureStorage(f.db);
      await storage.put(object, new Blob([text]).stream());
      await f.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable) values(${id},${t.s.organizationId},${t.s.workspaceId},${t.s.ownerId},${object.key},'artifacts','text/plain',${object.sizeBytes},${object.checksum},'ready',true)`;
      await f.db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,platform_test_run_id,file_name,format) values(${randomUUID()},${t.s.organizationId},${t.s.workspaceId},${t.s.ownerId},${id},${randomUUID()},1,${t.s.contextId},'independent.txt','text')`;
      const before = await history(t.s),
        p = await planFor(t.s);
      await applyPlan(p);
      expect(await history(t.s)).toEqual(before);
      expect(await new Response(await storage.get(object)).text()).toBe(text);
    });
    it('requires the exact normal close ACK plus child_close0; nonzero retains the registered owner', async () => {
      for (const code of [0, 1]) {
        const t = await subject(),
          o: DshRuntimeOwnedObservation = {
            version: 1,
            kind: 'owned',
            runtimeId: randomUUID(),
            workerBootId: randomUUID(),
            workerId: randomUUID(),
            serviceManifestDigest: digest('Synthetic C worker'),
            artifactId: t.artifacts[0]!,
            profileId: 'restricted',
            context: { kind: 'context', ...t.s },
            observedAt: new Date().toISOString(),
          };
        const r = await reserveDshRuntimeOwner(o),
          base = {
            version: 1 as const,
            runtimeId: o.runtimeId,
            workerBootId: o.workerBootId,
            ownerDigest: r.ownerDigest,
            observedAt: new Date().toISOString(),
          };
        await recordDshRuntimeCloseObservation(r, {
          ...base,
          kind: 'close_started',
        });
        await recordDshRuntimeCloseObservation(r, {
          ...base,
          kind: 'close_request',
          acknowledged: true,
          wrapper: {
            version: 1,
            sdkShutdown: true,
            rootDisposed: true,
            priorFramesFlushed: true,
          },
        });
        await recordDshRuntimeCloseObservation(r, {
          ...base,
          kind: 'process_closed',
          fact: {
            source: 'child_close',
            stdioClosed: true,
            exitCode: code,
            signal: null,
            terminationAttempted: null,
          },
        });
        if (code === 0) {
          const p = await planFor(t.s);
          await applyPlan(p);
          expect(await history(t.s)).toEqual(p.snapshots[0]);
        } else
          await expect(planFor(t.s)).rejects.toThrow(
            /REGISTERED_OWNER_UNCONFIRMED/,
          );
      }
    });
    it('refuses this boot source/binding even with an otherwise empty physical inventory', async () => {
      const t = await subject(),
        p = await planFor(t.s),
        e = proof(p);
      await expect(
        apply({
          plan: p,
          physicalProof: {
            ...e,
            workerBootStartedAt: '2000-01-01T00:00:00.000Z',
          },
        }),
      ).rejects.toThrow(/CURRENT_BOOT_CONTEXT_NOT_DISCARDABLE/);
      expect((await readback(p)).status).toBe('not-found');
    });

    it('cannot use a test binding to cut off an independent real business Run', async () => {
      const c = await createExperienceFixture(f.db),
        s: NativeTerminalTestScope = {
          contextKind: 'platform_employee_test',
          contextId: randomUUID(),
          organizationId: c.org,
          workspaceId: c.workspace,
          ownerId: c.user,
        };
      await f.db`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,completed_at) values(${s.contextId},${admin.employeeId},${admin.revisionId},'Synthetic inconsistent old test','succeeded','{}',clock_timestamp())`;
      await f.db`update allrice_runs set completed_at=clock_timestamp() where id=${c.run}`;
      const job = randomUUID();
      await f.db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,completed_at) values(${job},${c.org},${c.workspace},${c.user},${c.run},'succeeded',${job},clock_timestamp()+interval '1 hour','{}',clock_timestamp())`;
      const [before] =
        await f.db`select to_jsonb(e) row from allrice_employee_runs e where run_id=${c.run}`;
      await pin(s, c.run, job, digest(randomUUID()));
      await expect(planFor(s)).rejects.toThrow(/BUSINESS_RUN_CONFLICT/);
      expect(
        (
          await f.db`select to_jsonb(e) row from allrice_employee_runs e where run_id=${c.run}`
        )[0]!.row,
      ).toEqual(before!.row);
    });

    it('retains a malformed historical pin rather than treating the protected PPT namespace as test data', async () => {
      const t = await subject();
      await f.db`insert into allrice_native_session_bindings select (jsonb_populate_record(null::allrice_native_session_bindings,to_jsonb(b)||jsonb_build_object('native_session_id',${'dsh-' + randomUUID()}::text,'storage_context_key','68e76b6b-2e75-45b7-b628-951945b12044','storage_namespace',storage_namespace||'/68e76b6b-2e75-45b7-b628-951945b12044'))).* from allrice_native_session_bindings b where b.context_kind=${t.s.contextKind} and b.context_id=${t.s.contextId}`;
      await expect(planFor(t.s)).rejects.toThrow(/PROTECTED_CONTEXT/);
      expect(
        await f.db`select native_session_id from allrice_native_session_bindings where context_kind=${t.s.contextKind} and context_id=${t.s.contextId}`,
      ).toHaveLength(2);
    });
    it('a pending validation consumer must wait and cannot pass the committed cutoff', async () => {
      const t = await subject('experience_consolidation'),
        p = await planFor(t.s),
        held = await holdCutoff(p),
        tag = 'terminal-pending-consumer:' + randomUUID(),
        id = randomUUID();
      const late = f.db
        .begin(async (tx) => {
          await tx`select set_config('application_name',${tag},true)`;
          await tx`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,purpose,experience_binding) values(${id},${admin.employeeId},${admin.revisionId},'Synthetic already captured consumer','queued','{}','experience_validation',${tx.json({ schemaVersion: 1, occurrenceId: t.s.contextId, organizationId: t.s.organizationId, workspaceId: t.s.workspaceId, ownerId: t.s.ownerId, draftIndex: 0 })})`;
        })
        .then(
          () => ({ accepted: true }),
          (error) => ({ accepted: false, error }),
        );
      try {
        await waitForAdvisory(tag);
      } finally {
        held.release();
        await held.result;
      }
      expect(await late).toMatchObject({
        accepted: false,
        error: { message: expect.stringMatching(/retired/i) },
      });
      expect(
        await f.db`select id from allrice_platform_employee_test_runs where id=${id}`,
      ).toHaveLength(0);
      expect((await readback(p)).status).toBe('completed');
      expect((await history(t.s)).consumers).toEqual([]);
    });
    it('a pending child Run UPDATE cannot resurrect execution after the root cutoff', async () => {
      const t = await subject(),
        child = randomUUID();
      await f.db`insert into allrice_runtime_roots(root_run_id,organization_id,workspace_id,task,deadline_at) values(${t.run},${t.s.organizationId},${t.s.workspaceId},'{}',clock_timestamp()+interval '1 hour')`;
      await f.db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task) values(${t.run},${t.run},null,${t.s.organizationId},${t.s.workspaceId},'{}')`;
      await f.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,completed_at,execution_spec) values(${child},${t.s.organizationId},${t.s.workspaceId},${t.s.ownerId},'succeeded',clock_timestamp(),'{}')`;
      await f.db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task) values(${child},${t.run},${t.run},${t.s.organizationId},${t.s.workspaceId},'{}')`;
      const p = await planFor(t.s);
      expect(p.snapshots[0]!.runIds).toContain(child);
      const held = await holdCutoff(p),
        tag = 'terminal-pending-child:' + randomUUID();
      const late = f.db
        .begin(async (tx) => {
          await tx`select set_config('application_name',${tag},true)`;
          await tx`update allrice_runs set state='queued',completed_at=null where id=${child}`;
        })
        .then(
          () => ({ accepted: true }),
          (error) => ({ accepted: false, error }),
        );
      try {
        await waitForAdvisory(tag, ['transactionid', 'tuple']);
      } finally {
        held.release();
        await held.result;
      }
      expect(await late).toMatchObject({
        accepted: false,
        error: { message: expect.stringMatching(/retired/i) },
      });
      expect(
        (await f.db`select state from allrice_runs where id=${child}`)[0]!
          .state,
      ).toBe('succeeded');
      expect((await readback(p)).status).toBe('completed');
    });
  },
);
