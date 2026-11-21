import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { UuidSchema, type RequestContext } from '@allrice/contracts';
import { PersonVmError, type PersonVmBinding } from './contract.ts';

export type PersonVmWebRoster = Readonly<{
  personId: string;
  organizationId: string;
  entries: readonly Readonly<{
    workspaceId: string;
    employeeInstanceId: string;
    employeeRevision: number;
    employeeVersionId: string;
  }>[];
  digest: string;
}>;
export type PersonVmWebEndpointReceipt = Readonly<{
  binding: PersonVmBinding;
  rosterDigest: string;
  endpoints: readonly (PersonVmWebRoster['entries'][number] &
    Readonly<{ hostPort: number; guestPort: number }>)[];
}>;
/** Startup metadata from the service's authenticated caller, never guest JSON. */
export type PersonVmWebStartup = Readonly<{
  context: RequestContext;
  receipt: PersonVmWebEndpointReceipt;
}>;
export interface PersonVmWebRosterPort {
  prepare(
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<PersonVmWebRoster>;
}
const filename = 'allrice-native-web-endpoints.json';
type Manifest = {
  version: 1;
  vmId: string;
  personId: string;
  organizationId: string;
  digest: string;
  endpoints: PersonVmWebEndpointReceipt['endpoints'];
};
function invalid(): never {
  throw new PersonVmError('PROVIDER_FAILED');
}
function port(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) invalid();
  return value;
}
export function checkedWebRoster(roster: PersonVmWebRoster) {
  const entries = roster.entries
    .map((entry) => {
      if (
        !Number.isSafeInteger(entry.employeeRevision) ||
        entry.employeeRevision < 1
      )
        invalid();
      return Object.freeze({
        workspaceId: UuidSchema.parse(entry.workspaceId),
        employeeInstanceId: UuidSchema.parse(entry.employeeInstanceId),
        employeeRevision: entry.employeeRevision,
        employeeVersionId: UuidSchema.parse(entry.employeeVersionId),
      });
    })
    .sort((a, b) => a.employeeInstanceId.localeCompare(b.employeeInstanceId));
  if (
    new Set(entries.map((entry) => entry.employeeInstanceId)).size !==
    entries.length
  )
    invalid();
  const facts = {
    personId: UuidSchema.parse(roster.personId),
    organizationId: UuidSchema.parse(roster.organizationId),
    entries: Object.freeze(entries),
  };
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`;
  if (digest !== roster.digest) invalid();
  return Object.freeze({ ...facts, digest });
}
async function read(
  directory: string,
  binding: PersonVmBinding,
): Promise<Manifest | null> {
  let file;
  try {
    file = await open(
      join(directory, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid?.()
    )
      invalid();
    const value: Manifest = JSON.parse(await file.readFile('utf8'));
    if (
      value.version !== 1 ||
      value.vmId !== binding.vmId ||
      value.personId !== binding.personId ||
      value.organizationId !== binding.organizationId ||
      Object.keys(value).sort().join(',') !==
        'digest,endpoints,organizationId,personId,version,vmId'
    )
      invalid();
    checkedWebRoster({ ...value, entries: value.endpoints });
    const hosts = new Set<number>(),
      guests = new Set<number>();
    for (const endpoint of value.endpoints) {
      if (
        Object.keys(endpoint).sort().join(',') !==
        'employeeInstanceId,employeeRevision,employeeVersionId,guestPort,hostPort,workspaceId'
      )
        invalid();
      if (
        hosts.has(port(endpoint.hostPort)) ||
        guests.has(port(endpoint.guestPort))
      )
        invalid();
      hosts.add(endpoint.hostPort);
      guests.add(endpoint.guestPort);
    }
    return value;
  } finally {
    await file.close();
  }
}
async function write(directory: string, value: Manifest) {
  const temporary = join(directory, `${filename}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, filename));
  } finally {
    await rm(temporary, { force: true });
  }
}
function receipt(
  binding: PersonVmBinding,
  manifest: Manifest,
): PersonVmWebEndpointReceipt {
  return Object.freeze({
    binding: Object.freeze({ ...binding }),
    rosterDigest: manifest.digest,
    endpoints: Object.freeze(
      manifest.endpoints.map((entry) => Object.freeze({ ...entry })),
    ),
  });
}
export async function assertPreparedWebEndpoints(
  directory: string,
  binding: PersonVmBinding,
  expected: PersonVmWebEndpointReceipt,
) {
  if (
    !(
      [
        'vmId',
        'personId',
        'organizationId',
        'instanceId',
        'leaseEpoch',
      ] as const
    ).every((key) => expected.binding[key] === binding[key])
  )
    throw new PersonVmError('LEASE_LOST');
  const manifest = await read(directory, binding);
  if (
    !manifest ||
    expected.rosterDigest !== manifest.digest ||
    JSON.stringify(expected.endpoints) !== JSON.stringify(manifest.endpoints)
  )
    invalid();
}

/** Called only within the service's existing physical owner lease, after prepare.
 * Existing native mappings are immutable in this first-creation slice. */
export async function prepareWebEndpoints(input: {
  directory: string;
  binding: PersonVmBinding;
  roster: PersonVmWebRoster;
  state: 'absent' | 'stopped' | 'running' | 'unknown';
  signal: AbortSignal;
}): Promise<PersonVmWebEndpointReceipt> {
  input.signal.throwIfAborted();
  const roster = checkedWebRoster(input.roster);
  if (
    roster.personId !== input.binding.personId ||
    roster.organizationId !== input.binding.organizationId
  )
    invalid();
  const prior = await read(input.directory, input.binding);
  if (input.state === 'unknown') invalid();
  if (input.state !== 'absent') {
    if (!prior || prior.digest !== roster.digest)
      throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
    return receipt(input.binding, prior);
  }
  const reserved: Server[] = [];
  let prepared: PersonVmWebEndpointReceipt | undefined;
  let failed = false,
    failure: unknown;
  try {
    const endpoints: PersonVmWebEndpointReceipt['endpoints'][number][] = [];
    for (const entry of roster.entries) {
      input.signal.throwIfAborted();
      const previous = prior?.endpoints.find(
        (item) => item.employeeInstanceId === entry.employeeInstanceId,
      );
      const server = createServer();
      reserved.push(server);
      let abort = () => {};
      try {
        await new Promise<void>((resolve, reject) => {
          abort = () => reject(input.signal.reason);
          input.signal.addEventListener('abort', abort, { once: true });
          if (input.signal.aborted) {
            reject(input.signal.reason);
            return;
          }
          server.once('error', reject);
          server.listen(
            {
              host: '127.0.0.1',
              port: previous?.hostPort ?? 0,
              signal: input.signal,
            },
            resolve,
          );
        });
      } finally {
        input.signal.removeEventListener('abort', abort);
      }
      const address = server.address();
      if (!address || typeof address === 'string') invalid();
      endpoints.push({
        ...entry,
        hostPort: port(address.port),
        guestPort: previous?.guestPort ?? address.port,
      });
    }
    input.signal.throwIfAborted();
    if (
      new Set(endpoints.map((entry) => entry.guestPort)).size !==
      endpoints.length
    )
      invalid();
    const value: Manifest = {
      version: 1,
      vmId: input.binding.vmId,
      personId: roster.personId,
      organizationId: roster.organizationId,
      digest: roster.digest,
      endpoints,
    };
    await write(input.directory, value);
    input.signal.throwIfAborted();
    prepared = receipt(input.binding, value);
  } catch (error) {
    failed = true;
    failure = error;
  }
  const results = await Promise.allSettled(
    reserved.map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error &&
            (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
              ? reject(error)
              : resolve(),
          ),
        ),
    ),
  );
  const closeFailures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (closeFailures.length)
    throw new PersonVmError('CLEANUP_INCOMPLETE', {
      cause: new AggregateError([
        ...(failed ? [failure] : []),
        ...closeFailures,
      ]),
    });
  if (failed) throw failure;
  return prepared!;
}

/** Public v0.7.16 inspect flattens SandboxSpec; pending_changes does not cover
 * ports. Compare the actual desired AND running config explicitly. */
export function assertWebEndpointInspection(
  value: unknown,
  expectedName: string,
  expected: PersonVmWebEndpointReceipt,
  running: boolean,
) {
  const result = value as {
    name?: string;
    status?: string;
    config?: unknown;
    active_config?: unknown;
  };
  if (
    !result ||
    result.name !== expectedName ||
    (running && result.status !== 'Running')
  )
    invalid();
  const wanted = expected.endpoints
    .map((entry) => `127.0.0.1:${entry.hostPort}:${entry.guestPort}:tcp`)
    .sort();
  function compare(config: unknown) {
    const ports = (config as { network?: { ports?: unknown } } | null)?.network
      ?.ports;
    if (!Array.isArray(ports)) invalid();
    const actual = ports
      .map(
        (entry: {
          host_bind: string;
          host_port: number;
          guest_port: number;
          protocol: string;
        }) =>
          `${entry.host_bind}:${port(entry.host_port)}:${port(entry.guest_port)}:${entry.protocol}`,
      )
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) invalid();
  }
  compare(result.config);
  if (running) compare(result.active_config);
}
