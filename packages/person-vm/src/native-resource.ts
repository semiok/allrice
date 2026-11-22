import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { PersonVmError } from './contract.ts';
import type { PersonVmBinding } from './contract.ts';
import type {
  PersonVmManagedProbeJob,
  PersonVmManagedProbePort,
} from './native-command-observer.ts';

export type PersonVmGuestControlValue = number | 'max';
export type PersonVmGuestControlTarget = Readonly<{
  target: 'vm-controls' | 'commands' | 'dsh';
  path: string;
  high: PersonVmGuestControlValue;
  max: PersonVmGuestControlValue;
  swapMax: PersonVmGuestControlValue;
}>;
export type PersonVmGuestControlReadback = Readonly<{
  target: PersonVmGuestControlTarget['target'];
  path: string;
  state: 'verified' | 'unknown';
  reason: string | null;
  observed: Readonly<{
    device: string;
    inode: string;
    high: PersonVmGuestControlValue;
    max: PersonVmGuestControlValue;
    swapMax: PersonVmGuestControlValue;
  }> | null;
}>;
/** This is a guest controller observation, NEVER a physical RAM readback.
 * Guest root can change both controls and the reader. No security isolation. */
export type PersonVmGuestMemoryReadback = Readonly<{
  binding: PersonVmBinding;
  scope: 'guest-cgroup';
  boundary: 'guest-root-cooperative';
  state: 'verified' | 'unknown';
  revision: string;
  evidenceRef: string;
  groups: readonly PersonVmGuestControlReadback[];
}>;

const names = ['memory.high', 'memory.max', 'memory.swap.max'] as const;
const bindingKey = (binding: PersonVmBinding) =>
  JSON.stringify([
    binding.vmId,
    binding.personId,
    binding.organizationId,
    binding.instanceId,
    binding.leaseEpoch,
  ]);
const value = (input: unknown): input is PersonVmGuestControlValue =>
  input === 'max' ||
  (typeof input === 'number' && Number.isSafeInteger(input) && input >= 0);
const record = (input: unknown): input is Record<string, unknown> =>
  input !== null && typeof input === 'object' && !Array.isArray(input);
function control(input: unknown): PersonVmGuestControlValue | undefined {
  if (input === 'max') return input;
  if (typeof input !== 'string' || !/^(0|[1-9][0-9]*)$/.test(input))
    return undefined;
  const parsed = Number(input);
  return value(parsed) ? parsed : undefined;
}
const decimal = (input: unknown): input is string =>
  typeof input === 'string' && /^(0|[1-9][0-9]*)$/.test(input);

/** Fixed read-only guest probe. Expected limits deliberately stay on the host,
 * so absent/unreadable controls cannot be echoed back from configuration. */
export const PERSON_VM_GUEST_CONTROL_READER = String.raw`
const fs = require('node:fs'), path = require('node:path').posix;
const { cgroupRoot, targets } = JSON.parse(process.argv[1]);
const names = ['memory.high', 'memory.max', 'memory.swap.max'];
const canonical = p => typeof p === 'string' && p.startsWith('/') && p !== '/' && path.normalize(p) === p && !p.includes('\0') && fs.realpathSync(p) === p;
const checkDirectory = p => {
  if (!canonical(p)) throw new Error('noncanonical-cgroup-path');
  const stat = fs.statSync(p, { bigint: true });
  if (!stat.isDirectory() || fs.statfsSync(p, { bigint: true }).type !== 0x63677270n) throw new Error('not-cgroup2');
  return stat;
};
const read = (p, device) => {
  if (!canonical(p)) throw new Error('noncanonical-control-path');
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.dev !== device) throw new Error('invalid-control-identity');
    return { value: fs.readFileSync(fd, 'utf8').trim(), device: stat.dev, inode: stat.ino };
  } finally { fs.closeSync(fd); }
};
const groups = targets.map(({ target, path: directory }) => {
  try {
    if (!(directory === cgroupRoot || directory.startsWith(cgroupRoot + '/'))) throw new Error('outside-cgroup-root');
    const rootBefore = checkDirectory(cgroupRoot), before = checkDirectory(directory);
    if (before.dev !== rootBefore.dev) throw new Error('different-cgroup-device');
    const first = names.map(name => read(path.join(directory, name), before.dev));
    const second = names.map(name => read(path.join(directory, name), before.dev));
    const after = checkDirectory(directory), rootAfter = checkDirectory(cgroupRoot);
    if (rootBefore.dev !== rootAfter.dev || rootBefore.ino !== rootAfter.ino || before.dev !== after.dev || before.ino !== after.ino || first.some((v, i) => v.value !== second[i].value || v.device !== second[i].device || v.inode !== second[i].inode))
      return { target, path: directory, error: 'control-changed-during-read' };
    return { target, path: directory, device: String(before.dev), inode: String(before.ino), values: first.map(entry => entry.value) };
  } catch (error) { return { target, path: directory, error: error instanceof Error ? error.message : 'control-unreadable' }; }
});
process.stdout.write(JSON.stringify({ version: 1, scope: 'guest-cgroup', groups }));
`;

export function createPersonVmGuestMemoryReader(input: {
  binding: PersonVmBinding;
  /** Existing native owner/executor, including actual guest completion. */
  probes: PersonVmManagedProbePort;
  /** Explicit approved guest Node path; no guest PATH/default binary guess. */
  nodeExecutable: string;
  /** Existing owner's independent cleanup budget, not the aborted read. */
  cleanupSignal(): AbortSignal;
  cgroupRoot: string;
  /** Explicit approved plan expectations; no physical/child limit defaults. */
  targets: readonly PersonVmGuestControlTarget[];
}): {
  read(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<PersonVmGuestMemoryReadback>;
} {
  const binding = Object.freeze({ ...input.binding });
  const key = bindingKey(binding);
  const { probes, nodeExecutable, cleanupSignal } = input;
  const targets = input.targets.map((target) => Object.freeze({ ...target }));
  const root = input.cgroupRoot;
  const pathValid = (path: string) =>
    typeof path === 'string' &&
    posix.isAbsolute(path) &&
    posix.normalize(path) === path &&
    !path.includes('\0');
  if (
    typeof probes?.launch !== 'function' ||
    typeof cleanupSignal !== 'function' ||
    !pathValid(nodeExecutable) ||
    nodeExecutable === '/' ||
    !pathValid(root) ||
    root === '/' ||
    targets.length === 0 ||
    new Set(targets.map((target) => target.target)).size !== targets.length ||
    new Set(targets.map((target) => target.path)).size !== targets.length ||
    targets.some(
      (target) =>
        !['vm-controls', 'commands', 'dsh'].includes(target.target) ||
        !pathValid(target.path) ||
        !(target.path === root || target.path.startsWith(root + '/')) ||
        ![target.high, target.max, target.swapMax].every(value),
    )
  )
    throw new PersonVmError('RUNTIME_NOT_READY');

  const snapshot = (
    groups: PersonVmGuestControlReadback[],
  ): PersonVmGuestMemoryReadback => {
    const revision = createHash('sha256')
      .update(JSON.stringify([binding, groups]))
      .digest('hex');
    return Object.freeze({
      binding,
      scope: 'guest-cgroup',
      boundary: 'guest-root-cooperative',
      state: groups.every((group) => group.state === 'verified')
        ? 'verified'
        : 'unknown',
      revision,
      evidenceRef: `msb-managed-probe:guest-cgroup:${revision}`,
      groups: Object.freeze(groups),
    });
  };
  const unknown = (reason: string) =>
    snapshot(
      targets.map((target) =>
        Object.freeze({
          target: target.target,
          path: target.path,
          state: 'unknown' as const,
          reason,
          observed: null,
        }),
      ),
    );
  async function runProbe(signal: AbortSignal): Promise<string> {
    let job: PersonVmManagedProbeJob;
    try {
      job = await probes.launch(
        {
          executable: nodeExecutable,
          args: [
            '-e',
            PERSON_VM_GUEST_CONTROL_READER,
            JSON.stringify({
              cgroupRoot: root,
              targets: targets.map(({ target, path }) => ({ target, path })),
            }),
          ],
        },
        signal,
      );
    } catch (cause) {
      // With no retained exact job, dispatch may have succeeded. The source
      // owner must resolve this admission using its whole-VM stop/status path.
      throw new PersonVmError('CLEANUP_INCOMPLETE', { cause });
    }
    if (!job || !record(job.binding) || bindingKey(job.binding) !== key)
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    let joined = false;
    try {
      signal.throwIfAborted();
      if (!job.jobId || typeof job.stdout !== 'function')
        throw new PersonVmError('RUNTIME_NOT_READY');
      const exit = await job.wait(signal);
      if (
        !Number.isInteger(exit?.exitCode) ||
        typeof exit?.timedOut !== 'boolean'
      )
        throw new PersonVmError('RUNTIME_NOT_READY');
      joined = true;
      signal.throwIfAborted();
      if (exit.exitCode !== 0 || exit.timedOut)
        throw new PersonVmError('RUNTIME_NOT_READY');
      const output = await job.stdout(signal);
      signal.throwIfAborted();
      return output;
    } catch (cause) {
      if (!joined) {
        try {
          const exit = await job.cancelAndWait(cleanupSignal());
          if (
            !Number.isInteger(exit?.exitCode) ||
            typeof exit?.timedOut !== 'boolean'
          )
            throw new Error('unconfirmed-guest-probe-cleanup');
        } catch (cleanup) {
          throw new PersonVmError('CLEANUP_INCOMPLETE', {
            cause: new AggregateError([cause, cleanup]),
          });
        }
      }
      signal.throwIfAborted();
      throw cause;
    }
  }
  return {
    async read(bindingInput, signal) {
      signal.throwIfAborted();
      if (bindingKey(bindingInput) !== key)
        throw new PersonVmError('LEASE_LOST');
      try {
        const raw: unknown = JSON.parse(await runProbe(signal));
        signal.throwIfAborted();
        if (
          !record(raw) ||
          raw.version !== 1 ||
          raw.scope !== 'guest-cgroup' ||
          !Array.isArray(raw.groups) ||
          raw.groups.length !== targets.length
        )
          return unknown('invalid-public-readback');
        const rawGroups: readonly unknown[] = raw.groups;
        const groups: PersonVmGuestControlReadback[] = [];
        for (const [index, target] of targets.entries()) {
          const group = rawGroups[index];
          if (
            !record(group) ||
            group.target !== target.target ||
            group.path !== target.path
          )
            return unknown('readback-target-mismatch');
          let observed: PersonVmGuestControlReadback['observed'] = null;
          if (
            !group.error &&
            decimal(group.device) &&
            decimal(group.inode) &&
            group.inode !== '0' &&
            Array.isArray(group.values) &&
            group.values.length === names.length
          ) {
            const rawValues: readonly unknown[] = group.values;
            const values = rawValues.map(control);
            if (values.every((entry) => entry !== undefined))
              observed = Object.freeze({
                device: group.device,
                inode: group.inode,
                high: values[0]!,
                max: values[1]!,
                swapMax: values[2]!,
              });
          }
          const matches =
            observed &&
            observed.high === target.high &&
            observed.max === target.max &&
            observed.swapMax === target.swapMax;
          groups.push(
            Object.freeze({
              target: target.target,
              path: target.path,
              state: matches ? 'verified' : 'unknown',
              reason: matches
                ? null
                : observed
                  ? 'control-readback-mismatch'
                  : 'control-readback-unavailable',
              observed,
            }),
          );
        }
        return snapshot(groups);
      } catch (cause) {
        if (
          cause instanceof PersonVmError &&
          cause.code === 'CLEANUP_INCOMPLETE'
        )
          throw cause;
        signal.throwIfAborted();
        return unknown('public-managed-probe-unavailable');
      }
    },
  };
}
