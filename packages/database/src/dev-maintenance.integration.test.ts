/** Physical PostgreSQL protocol checks; control bindings are synthetic fixture
 * rows, never installed supervisors or real Dev maintenance requests. */
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import {
  enqueueRun,
  claimNextJob,
  startClaimedJob,
} from './execution/queue.ts';
import { claimNextPlatformEmployeeTestRun } from './employees/platform-employees.ts';
import {
  acquireDevAdmission,
  startDevProducer,
  finishDevProducer,
  requestDevMaintenance,
  releaseDevMaintenance,
  acknowledgeDevMaintenance,
  readDevMaintenance,
  devProducerCatalog,
  type DevMaintenanceOwner,
} from './dev-maintenance.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('Durable maintenance fence, without installed host authority', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  let company: Awaited<ReturnType<typeof createExperienceFixture>>;
  let owner: DevMaintenanceOwner;
  const instances = {
    web: { bootId: randomUUID(), manifestDigest: 'sha256:' + 'a'.repeat(64) },
    worker: {
      bootId: randomUUID(),
      manifestDigest: 'sha256:' + 'b'.repeat(64),
    },
  };
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    company = await createExperienceFixture(fixture.db);
    vi.stubEnv('ALLRICE_DEV_MAINTENANCE_ENABLED', '1');
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  const submit = async () =>
    (
      await enqueueRun(company.owner, {
        workspaceId: company.workspace,
        idempotencyKey: randomUUID(),
        type: 'maintenance.fixture',
        input: {},
        timeoutMs: 300000,
        maxAttempts: 1,
      })
    ).run;
  beforeEach(async () => {
    await fixture.db`update allrice_dev_maintenance set state='open',owner_job_id=null,owner_attempt=null,owner_boot_id=null,expected_instances='{}'`;
    await fixture.db`update allrice_dev_producer_permits set finished_at=clock_timestamp() where finished_at is null`;
    await fixture.db`update allrice_jobs set status='canceled' where status in ('queued','claimed','running','retry_wait','waiting_approval')`;
    const run = await submit(),
      workerId = randomUUID(),
      leaseToken = randomUUID();
    await fixture.db`update allrice_jobs set payload=${fixture.db.json({ schemaVersion: 1, type: 'allrice.platform.dev.release', input: {} })},
      status='running',worker_id=${workerId},attempt=1,lease_token=${leaseToken},claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '5 minutes' where run_id=${run.id}`;
    const [row] = await fixture.db<
      { id: string }[]
    >`select id from allrice_jobs where run_id=${run.id}`;
    owner = {
      jobId: row!.id,
      attempt: 1,
      leaseToken,
      supervisorBootId: randomUUID(),
      installedIdentityDigest: 'sha256:' + 'c'.repeat(64),
    };
    await fixture.db`insert into allrice_dev_control_owners(job_id,supervisor_boot_id,installed_identity_digest) values(${owner.jobId},${owner.supervisorBootId},${owner.installedIdentityDigest})`;
  });
  it('does not grant authority from the namespace, wrong instance, canceled or expired lease', async () => {
    await expect(
      requestDevMaintenance(
        { ...owner, supervisorBootId: randomUUID() },
        instances,
      ),
    ).rejects.toMatchObject({ code: 'dev_control_authority_denied' });
    await fixture.db`delete from allrice_dev_control_owners where job_id=${owner.jobId}`;
    await expect(requestDevMaintenance(owner, instances)).rejects.toMatchObject(
      { code: 'dev_control_authority_denied' },
    );
    await fixture.db`insert into allrice_dev_control_owners(job_id,supervisor_boot_id,installed_identity_digest) values(${owner.jobId},${owner.supervisorBootId},${owner.installedIdentityDigest})`;
    await fixture.db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${owner.jobId}`;
    await expect(requestDevMaintenance(owner, instances)).rejects.toMatchObject(
      { code: 'dev_control_authority_denied' },
    );
    await fixture.db`update allrice_jobs set cancel_requested_at=null,lease_expires_at=clock_timestamp()-interval '1 second' where id=${owner.jobId}`;
    await expect(requestDevMaintenance(owner, instances)).rejects.toMatchObject(
      { code: 'dev_control_authority_denied' },
    );
    expect((await readDevMaintenance())?.state).toBe('open');
  });
  it('busy ordinary and retry jobs exit before changing the epoch; another control is not excluded by prefix', async () => {
    const run = await submit();
    const initial = (await readDevMaintenance())!.epoch;
    for (const status of ['queued', 'retry_wait', 'waiting_approval']) {
      await fixture.db`update allrice_jobs set status=${status} where run_id=${run.id}`;
      expect(await requestDevMaintenance(owner, instances)).toMatchObject({
        requested: false,
        busy: { jobs: 1 },
      });
    }
    await fixture.db`update allrice_jobs set payload=${fixture.db.json({ schemaVersion: 1, type: 'allrice.platform.dev.other', input: {} })} where run_id=${run.id}`;
    expect((await requestDevMaintenance(owner, instances)).requested).toBe(
      false,
    );
    expect((await readDevMaintenance())!.epoch).toBe(initial);
  });
  it('holds SHARE until the admission transaction commits; maintenance rechecks the resulting durable busy fact', async () => {
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((r) => (entered = r)),
      held = new Promise<void>((r) => (release = r));
    const admission = fixture.db.begin(async (tx) => {
      await acquireDevAdmission(tx);
      entered();
      await held;
      await tx`insert into allrice_dev_producer_permits(id,epoch,instance_boot_id,role,producer) values(${randomUUID()},0,${instances.web.bootId},'web','canonical_admission')`;
    });
    await ready;
    let settled = false;
    const request = requestDevMaintenance(owner, instances).finally(
      () => (settled = true),
    );
    // Observe PostgreSQL lock wait, instead of sleeping and assuming contention.
    for (let i = 0; i < 100; i++) {
      const [r] =
        await fixture.db`select count(*)::int n from pg_stat_activity where application_name=${(await fixture.db`select current_schema() name`)[0]!.name} and wait_event_type='Lock'`;
      if (r?.n > 0) break;
      if (i === 99) throw Error('LOCK_CONTENTION_NOT_OBSERVED');
    }
    expect(settled).toBe(false);
    release();
    await admission;
    expect(await request).toMatchObject({
      requested: false,
      busy: { permits: 1 },
    });
    expect((await readDevMaintenance())!.state).toBe('open');
  });
  it('requested maintenance blocks new canonical writes, ordinary claim/start and direct employee-test claim', async () => {
    const before = await fixture.db`select count(*)::int n from allrice_runs`;
    const requested = await requestDevMaintenance(owner, instances);
    expect(requested.requested).toBe(true);
    await expect(submit()).rejects.toMatchObject({
      code: 'dev_maintenance_requested',
    });
    expect(await fixture.db`select count(*)::int n from allrice_runs`).toEqual(
      before,
    );
    expect(await claimNextJob(randomUUID(), 30000)).toBeNull();
    expect(
      await startClaimedJob(randomUUID(), owner.jobId, owner.leaseToken),
    ).toBeNull();
    expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
  });
  it('uses a fresh DB clock after a barrier wait, rejecting an expired start and issuing a fresh claim lease', async () => {
    const run = await submit(),
      workerId = randomUUID();
    const claimed = await claimNextJob(workerId, 1000);
    expect(claimed?.id).toBe(run.job.id);
    let unlock!: () => void, entered!: () => void;
    const lockReady = new Promise<void>((r) => (entered = r)),
      held = new Promise<void>((r) => (unlock = r));
    const locking = fixture.db.begin(async (tx) => {
      await tx`select * from allrice_dev_maintenance for update`;
      entered();
      await held;
    });
    await lockReady;
    const start = startClaimedJob(workerId, claimed!.id, claimed!.lease!.token);
    const caught = start.catch((e) => e);
    // Bound, deterministic DB-time advance while the actual gate is locked.
    await fixture.db`select pg_sleep(1.1)`;
    unlock();
    await locking;
    expect(await caught).toMatchObject({ code: 'lease_lost' });
    const [saved] =
      await fixture.db`select status from allrice_jobs where id=${claimed!.id}`;
    expect(saved!.status).toBe('claimed');
    await fixture.db`update allrice_jobs set status='canceled' where id=${claimed!.id}`;
    await submit();
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>((r) => (locked = r)),
      wait = new Promise<void>((r) => (release = r));
    const barrier = fixture.db.begin(async (tx) => {
      await tx`select * from allrice_dev_maintenance for update`;
      locked();
      await wait;
    });
    await ready;
    const next = claimNextJob(workerId, 1000);
    await fixture.db`select pg_sleep(1.1)`;
    release();
    await barrier;
    const lease = await next;
    const [clock] = await fixture.db`select clock_timestamp() now`;
    expect(lease!.lease!.expiresAt > clock!.now.toISOString()).toBe(true);
  });
  it('unfinished producer permits stay busy regardless of age; only the exact instance may finish', async () => {
    const permit = await startDevProducer({
      instanceBootId: instances.worker.bootId,
      role: 'worker',
      producer: 'provider_probe',
    });
    await fixture.db`update allrice_dev_producer_permits set started_at=clock_timestamp()-interval '1 day' where id=${permit.id}`;
    expect(await requestDevMaintenance(owner, instances)).toMatchObject({
      requested: false,
      busy: { permits: 1 },
    });
    await expect(
      finishDevProducer({ ...permit, instanceBootId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'dev_barrier_stale' });
    await finishDevProducer(permit);
    await finishDevProducer(permit);
    expect((await requestDevMaintenance(owner, instances)).requested).toBe(
      true,
    );
  });
  it('rejects stale epoch/lease/build ACKs, records the full uninstalled catalog and cannot declare host readiness', async () => {
    const r = await requestDevMaintenance(owner, instances);
    if (!r.requested) throw Error('request denied');
    const ack = {
      role: 'web' as const,
      instance: instances.web,
      inFlight: 0,
      unknownProducers: [],
    };
    await expect(
      acknowledgeDevMaintenance(owner, r.epoch - 1, ack),
    ).rejects.toThrow();
    await expect(
      acknowledgeDevMaintenance(
        { ...owner, leaseToken: randomUUID() },
        r.epoch,
        ack,
      ),
    ).rejects.toMatchObject({ code: 'dev_control_authority_denied' });
    await expect(
      acknowledgeDevMaintenance(owner, r.epoch, {
        ...ack,
        instance: {
          ...instances.web,
          manifestDigest: instances.worker.manifestDigest,
        },
      }),
    ).rejects.toMatchObject({ code: 'dev_barrier_stale' });
    expect(await acknowledgeDevMaintenance(owner, r.epoch, ack)).toEqual({
      idle: false,
    });
    const [saved] =
      await fixture.db`select unknown_producers,in_flight from allrice_dev_maintenance_acks where epoch=${r.epoch}`;
    expect(saved!.unknown_producers).toEqual([...devProducerCatalog]);
    expect(saved!.in_flight).toBe(0);
    expect((await readDevMaintenance())?.state).toBe('requested');
  });
  it('only the current owner/epoch can withdraw its own request; expired lease does not reopen maintenance', async () => {
    const r = await requestDevMaintenance(owner, instances);
    if (!r.requested) throw Error('request denied');
    await expect(
      releaseDevMaintenance(owner, r.epoch + 1),
    ).rejects.toMatchObject({ code: 'dev_barrier_stale' });
    await expect(
      releaseDevMaintenance({ ...owner, attempt: 2 }, r.epoch),
    ).rejects.toMatchObject({ code: 'dev_control_authority_denied' });
    await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${owner.jobId}`;
    await expect(releaseDevMaintenance(owner, r.epoch)).rejects.toMatchObject({
      code: 'dev_control_authority_denied',
    });
    expect((await readDevMaintenance())!.state).toBe('requested');
    await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '1 minute' where id=${owner.jobId}`;
    await releaseDevMaintenance(owner, r.epoch);
    expect((await readDevMaintenance())!.state).toBe('open');
  });
});
