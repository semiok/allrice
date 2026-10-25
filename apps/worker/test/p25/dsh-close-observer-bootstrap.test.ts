import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DshCloseObservationDetails,
  DshRuntimeOwnedObservationSchema,
} from '@allrice/database';
import { observeDshWorkerCloseIdentity } from '../../src/harness/dsh-worker-close-identity.js';

const io = vi.hoisted(() => ({
  reserve: vi.fn(),
  record: vi.fn(),
  construct: vi.fn(),
  native: vi.fn(),
}));
vi.mock('@allrice/database', async (importOriginal) => {
  const real = await importOriginal<{
    DshRuntimeOwnedObservationSchema: typeof DshRuntimeOwnedObservationSchema;
  }>();
  return {
    DshRuntimeOwnedObservationSchema: real.DshRuntimeOwnedObservationSchema,
    reserveDshRuntimeOwner: io.reserve,
    recordDshRuntimeCloseObservation: io.record,
  };
});
vi.mock('../../src/harness/dsh-native-artifact.js', () => ({
  checkedDshNativeLaunch: io.native,
}));
vi.mock('../../src/harness/dsh-protocol-client.js', () => ({
  DshProtocolClient: class {
    constructor(options: unknown) {
      io.construct(options);
    }
  },
}));
const digest = (value: string) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
const artifactId = digest(
  'synthetic native; constructor and all OS spawn replaced',
);
const roots: string[] = [];
let originalArgv: string[], sequence: string[];
beforeEach(() => {
  originalArgv = process.argv;
  sequence = [];
  vi.resetModules();
  vi.stubEnv('ALLRICE_SERVICE_ROLE', 'worker');
  io.reserve.mockReset().mockImplementation(async (owner) => {
    sequence.push('reserve/readback');
    return { owner, ownerDigest: digest(JSON.stringify(owner)) };
  });
  io.record.mockReset().mockResolvedValue(undefined);
  io.construct.mockReset().mockImplementation(() => {
    sequence.push('construction');
  });
  io.native
    .mockReset()
    .mockReturnValue({ artifactId, profileId: 'restricted' });
});
afterEach(async () => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function measured() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-close-bootstrap-')),
  );
  roots.push(root);
  const entrypoint = join(root, 'dist', 'index.js');
  await mkdir(join(root, 'dist'));
  await writeFile(entrypoint, '// unit fixture of actual measured bytes\n');
  process.argv = [process.execPath, entrypoint];
  return observeDshWorkerCloseIdentity({
    workerId: randomUUID(),
    workerBootId: randomUUID(),
    entrypoint: pathToFileURL(entrypoint).href,
    nativeArtifactId: artifactId,
    serviceBuildIdentity: null,
  });
}
const request = () => ({
  launch: {
    command: '/synthetic/not-spawned',
    args: [],
    cwd: '/synthetic',
    environment: {},
    requestTimeoutMs: 1000,
  },
  context: { kind: 'provider' as const, purpose: 'codex_probe' as const },
});
describe('Non-Dev bootstrap uses the same durable close authority before and after construction', () => {
  it('reserves/readbacks with the measured boot before construction and retains exact ownership on a later write failure', async () => {
    const observed = await measured();
    const observer = await import('../../src/harness/dsh-close-observer.js');
    observer.installDshCloseObservationIdentity(observed.identity);
    await observer.createObservedDshClient(request());
    expect(sequence).toEqual(['reserve/readback', 'construction']);
    const owner = io.reserve.mock.calls[0]![0];
    expect(owner).toMatchObject({ ...observed.identity, artifactId });
    const options = io.construct.mock.calls[0]![0] as {
      observeClose(details: DshCloseObservationDetails): Promise<void>;
    };
    const failure = Error('durable close observation unavailable');
    io.record.mockRejectedValueOnce(failure);
    await expect(options.observeClose({ kind: 'close_started' })).rejects.toBe(
      failure,
    );
    expect(io.reserve).toHaveBeenCalledTimes(1);
    expect(io.record.mock.calls[0]![0]).toMatchObject({ owner });
    expect(io.record.mock.calls[0]![1]).toMatchObject({
      kind: 'close_started',
      workerBootId: observed.identity.workerBootId,
      runtimeId: owner.runtimeId,
    });
    // No process-close or SDK ACK is invented by identity installation.
    expect(io.record.mock.calls).toHaveLength(1);
  });
  it('cannot construct when the durable owner reservation is unconfirmed', async () => {
    const observed = await measured();
    const observer = await import('../../src/harness/dsh-close-observer.js');
    observer.installDshCloseObservationIdentity(observed.identity);
    const failure = Error('unknown owner COMMIT');
    io.reserve.mockRejectedValueOnce(failure);
    await expect(observer.createObservedDshClient(request())).rejects.toBe(
      failure,
    );
    expect(io.construct).not.toHaveBeenCalled();
    expect(io.record).not.toHaveBeenCalled();
  });
  it('records a legitimate admission fence as never-spawned only after reserve, before any construction', async () => {
    const observed = await measured();
    const observer = await import('../../src/harness/dsh-close-observer.js');
    observer.installDshCloseObservationIdentity(observed.identity);
    const failure = Error('admission is closed');
    await expect(
      observer.createObservedDshClient({
        ...request(),
        assertAdmissionOpen() {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(io.reserve).toHaveBeenCalledOnce();
    expect(io.construct).not.toHaveBeenCalled();
    expect(io.record.mock.calls[0]![1]).toMatchObject({
      kind: 'process_closed',
      workerBootId: observed.identity.workerBootId,
      fact: { source: 'never_spawned', spawnAttempted: false },
    });
  });
  it('retains the original one-time installer and refuses a missing Worker authority', async () => {
    const observer = await import('../../src/harness/dsh-close-observer.js');
    await expect(observer.createObservedDshClient(request())).rejects.toThrow(
      'DSH_CLOSE_OBSERVER_REQUIRED',
    );
    expect(io.construct).not.toHaveBeenCalled();
    const observed = await measured();
    observer.installDshCloseObservationIdentity(observed.identity);
    expect(() =>
      observer.installDshCloseObservationIdentity({
        ...observed.identity,
        workerBootId: randomUUID(),
      }),
    ).toThrow('DSH_CLOSE_OBSERVER_ALREADY_INSTALLED');
  });
});
