import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type postgres from 'postgres';
import { getDatabase } from './core/client.ts';
import { devReleaseJobType } from './dev-release-control.ts';

type Transaction = postgres.TransactionSql;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const devProducerCatalog = [
  'canonical_admission',
  'ordinary_consumer',
  'queue_recovery',
  'parked_continuation',
  'automation',
  'folder_import',
  'employee_test',
  'tool_dispatch',
  'provider_authorization',
  'provider_probe',
  'runtime_inventory',
  'mcp_discovery',
  'mcp_recovery',
  'managed_cloud',
  'cloud_recovery',
  'cloud_service',
  'bridge_admission',
  'bridge_frame',
  'bridge_dispatch',
  'preview_http',
  'preview_socket',
  'preview_transport',
  'storage_upload',
  'repository_action',
] as const;
export const devProducerCoverageVersion = 1;
const ownerSchema = z
  .object({
    jobId: z.uuid(),
    attempt: z.number().int().positive(),
    leaseToken: z.uuid(),
    supervisorBootId: z.uuid(),
    installedIdentityDigest: digest,
  })
  .strict();
export type DevMaintenanceOwner = z.infer<typeof ownerSchema>;
const instanceSchema = z
  .object({ bootId: z.uuid(), manifestDigest: digest })
  .strict();
const instancesSchema = z
  .object({ web: instanceSchema, worker: instanceSchema })
  .strict();
type Instances = z.infer<typeof instancesSchema>;
interface BarrierRow {
  epoch: string;
  state: 'open' | 'requested' | 'quiesced';
  owner_job_id: string | null;
  owner_attempt: number | null;
  owner_boot_id: string | null;
  expected_instances: Instances;
}
export class DevMaintenanceError extends Error {
  constructor(
    readonly code:
      | 'dev_maintenance_requested'
      | 'dev_control_authority_denied'
      | 'dev_barrier_stale',
  ) {
    super(code);
  }
}

/** First lock of the business transaction, before domain/root/job locks. A
 * rejected admission rolls back every domain write; a missing row fails closed. */
function enabled() {
  return process.env.ALLRICE_DEV_MAINTENANCE_ENABLED === '1';
}
function requireEnabled() {
  if (!enabled()) throw new DevMaintenanceError('dev_control_authority_denied');
}
export async function acquireDevAdmission(transaction: Transaction) {
  if (!enabled()) return 0;
  const [row] = await transaction<
    BarrierRow[]
  >`select * from allrice_dev_maintenance where environment_id='dev' for share`;
  if (!row || row.state !== 'open')
    throw new DevMaintenanceError('dev_maintenance_requested');
  return Number(row.epoch);
}
export async function devAdmissionOpen(transaction: Transaction) {
  try {
    await acquireDevAdmission(transaction);
    return true;
  } catch (e) {
    if (
      e instanceof DevMaintenanceError &&
      e.code === 'dev_maintenance_requested'
    )
      return false;
    throw e;
  }
}
export async function readDevMaintenance() {
  if (!enabled()) return null;
  const [row] = await getDatabase()<
    BarrierRow[]
  >`select * from allrice_dev_maintenance where environment_id='dev'`;
  if (!row) throw new DevMaintenanceError('dev_maintenance_requested');
  // Host authority and lease secrets never appear in health responses.
  return {
    environment: 'dev' as const,
    state: row.state,
    epoch: Number(row.epoch),
    releaseAdmission: 'disabled' as const,
    producerCoverage: 'not_installed' as const,
  };
}

/** Internal control protocol only. No HTTP/model tool or installation API
 * exports these controls. A reserved Job type alone is never authority. */
async function assertOwner(tx: Transaction, input: DevMaintenanceOwner) {
  const o = ownerSchema.parse(input);
  requireEnabled();
  await tx`select id from allrice_jobs where id=${o.jobId} for update`;
  // Predicates evaluated before a blocking row lock are not a fresh lease proof.
  const [v] =
    await tx`select j.id from allrice_jobs j join allrice_dev_control_owners c on c.job_id=j.id
    where j.id=${o.jobId} and j.payload->>'type'=${devReleaseJobType}
      and j.status='running' and j.attempt=${o.attempt} and j.lease_token=${o.leaseToken}
      and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp()
      and j.cancel_requested_at is null and c.supervisor_boot_id=${o.supervisorBootId}
      and c.installed_identity_digest=${o.installedIdentityDigest}`;
  if (!v) throw new DevMaintenanceError('dev_control_authority_denied');
  return o;
}
async function lockBarrier(tx: Transaction) {
  const [b] = await tx<
    BarrierRow[]
  >`select * from allrice_dev_maintenance where environment_id='dev' for update`;
  if (!b) throw new DevMaintenanceError('dev_barrier_stale');
  return b;
}
function matches(b: BarrierRow, o: DevMaintenanceOwner, epoch: number) {
  return (
    Number(b.epoch) === epoch &&
    b.owner_job_id === o.jobId &&
    b.owner_attempt === o.attempt &&
    b.owner_boot_id === o.supervisorBootId
  );
}
async function busy(tx: Transaction, ownJobId: string) {
  const [v] = await tx`
    select (select count(*)::int from allrice_jobs where id<>${ownJobId}
      and status in ('queued','claimed','running','retry_wait','waiting_approval')) jobs,
    (select count(*)::int from allrice_platform_employee_test_runs where status in ('queued','running')) employee_tests,
    (select count(*)::int from allrice_dev_producer_permits where finished_at is null) permits,
    (select count(*)::int from allrice_runtime_operations where lease_expires_at>clock_timestamp()) runtime_leases,
    (select count(*)::int from allrice_provider_authorization_flows where state in ('pending','running','awaiting_user')) provider_flows`;
  return v as Record<string, number>;
}
export async function requestDevMaintenance(
  input: DevMaintenanceOwner,
  instances: Instances,
) {
  const expected = instancesSchema.parse(instances);
  if (expected.web.bootId === expected.worker.bootId)
    throw new DevMaintenanceError('dev_barrier_stale');
  return getDatabase().begin(async (tx) => {
    const b = await lockBarrier(tx),
      o = await assertOwner(tx, input);
    if (b.state !== 'open') throw new DevMaintenanceError('dev_barrier_stale');
    const facts = await busy(tx, o.jobId);
    if (Object.values(facts).some((n) => n > 0))
      return { requested: false as const, busy: facts };
    const [row] = await tx<
      { epoch: string }[]
    >`update allrice_dev_maintenance set
      epoch=epoch+1,state='requested',owner_job_id=${o.jobId},owner_attempt=${o.attempt},owner_boot_id=${o.supervisorBootId},
      expected_instances=${tx.json(expected)},requested_at=clock_timestamp(),updated_at=clock_timestamp()
      where environment_id='dev' returning epoch`;
    return { requested: true as const, epoch: Number(row!.epoch) };
  });
}
export async function startDevProducer(input: {
  instanceBootId: string;
  role: 'web' | 'worker';
  producer: (typeof devProducerCatalog)[number];
}) {
  const value = z
    .object({
      instanceBootId: z.uuid(),
      role: z.enum(['web', 'worker']),
      producer: z.enum(devProducerCatalog),
    })
    .strict()
    .parse(input);
  requireEnabled();
  const id = randomUUID();
  await getDatabase().begin(async (tx) => {
    const epoch = await acquireDevAdmission(tx);
    await tx`insert into allrice_dev_producer_permits(id,epoch,instance_boot_id,role,producer)
      values(${id},${epoch},${value.instanceBootId},${value.role},${value.producer})`;
  });
  return { id, instanceBootId: value.instanceBootId };
}
export async function finishDevProducer(permit: {
  id: string;
  instanceBootId: string;
}) {
  const id = z.uuid().parse(permit.id),
    boot = z.uuid().parse(permit.instanceBootId);
  const rows =
    await getDatabase()`update allrice_dev_producer_permits set finished_at=coalesce(finished_at,clock_timestamp())
    where id=${id} and instance_boot_id=${boot} returning id`;
  if (!rows.length) throw new DevMaintenanceError('dev_barrier_stale');
}
export async function acknowledgeDevMaintenance(
  input: DevMaintenanceOwner,
  epoch: number,
  ack: {
    role: 'web' | 'worker';
    instance: z.infer<typeof instanceSchema>;
    inFlight: number;
    unknownProducers: string[];
  },
) {
  epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(epoch);
  const value = z
    .object({
      role: z.enum(['web', 'worker']),
      instance: instanceSchema,
      inFlight: z.number().int().nonnegative(),
      unknownProducers: z
        .array(z.enum(devProducerCatalog))
        .max(devProducerCatalog.length),
    })
    .strict()
    .parse(ack);
  return getDatabase().begin(async (tx) => {
    const b = await lockBarrier(tx),
      o = await assertOwner(tx, input);
    if (
      b.state !== 'requested' ||
      !matches(b, o, epoch) ||
      b.expected_instances[value.role]?.bootId !== value.instance.bootId ||
      b.expected_instances[value.role]?.manifestDigest !==
        value.instance.manifestDigest
    )
      throw new DevMaintenanceError('dev_barrier_stale');
    const [permitCount] = await tx<
      { n: number }[]
    >`select count(*)::int n from allrice_dev_producer_permits where instance_boot_id=${value.instance.bootId} and finished_at is null`;
    const inFlight = Math.max(value.inFlight, permitCount!.n);
    const unknown = [
      ...new Set([...devProducerCatalog, ...value.unknownProducers]),
    ];
    await tx`insert into allrice_dev_maintenance_acks(epoch,role,instance_boot_id,owner_job_id,owner_attempt,owner_boot_id,manifest_digest,coverage_version,in_flight,unknown_producers)
      values(${epoch},${value.role},${value.instance.bootId},${o.jobId},${o.attempt},${o.supervisorBootId},${value.instance.manifestDigest},${devProducerCoverageVersion},${inFlight},${unknown})
      on conflict(epoch,role) do update set instance_boot_id=excluded.instance_boot_id,manifest_digest=excluded.manifest_digest,
        coverage_version=excluded.coverage_version,in_flight=excluded.in_flight,unknown_producers=excluded.unknown_producers,observed_at=clock_timestamp()`;
    return { idle: inFlight === 0 && unknown.length === 0 };
  });
}
export async function releaseDevMaintenance(
  input: DevMaintenanceOwner,
  epoch: number,
) {
  epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(epoch);
  return getDatabase().begin(async (tx) => {
    const b = await lockBarrier(tx),
      o = await assertOwner(tx, input);
    if (!matches(b, o, epoch) || b.state !== 'requested')
      throw new DevMaintenanceError('dev_barrier_stale');
    await tx`update allrice_dev_maintenance set state='open',owner_job_id=null,owner_attempt=null,owner_boot_id=null,
      expected_instances='{}',requested_at=null,updated_at=clock_timestamp() where environment_id='dev'`;
  });
}

// Deliberately no transition to quiesced/host START. A complete 24-producer
// installation and independently installed supervisor are still required.
