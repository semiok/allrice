import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { PersonVmError } from './contract.ts';
import type { PersonVmBinding } from './contract.ts';
import type { bootstrapMicrosandbox } from './microsandbox-bootstrap.ts';

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

// The existing bootstrap provider's public msb command capability. This reader
// neither launches ordinary DSH commands nor creates a second execution owner.
type NativeCommand = Parameters<typeof bootstrapMicrosandbox>[0]['command'];
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
  input === 'max' || (Number.isSafeInteger(input) && (input as number) >= 0);
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
const fs = require('node:fs'), path = require('node:path');
const targets = JSON.parse(process.argv[1]);
const names = ['memory.high', 'memory.max', 'memory.swap.max'];
const groups = targets.map(({ target, path: directory }) => {
  try {
    const before = fs.statSync(directory, { bigint: true });
    const first = names.map(name => fs.readFileSync(path.join(directory, name), 'utf8').trim());
    const second = names.map(name => fs.readFileSync(path.join(directory, name), 'utf8').trim());
    const after = fs.statSync(directory, { bigint: true });
    if (!before.isDirectory() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || first.some((v, i) => v !== second[i]))
      return { target, path: directory, error: 'control-changed-during-read' };
    return { target, path: directory, device: String(before.dev), inode: String(before.ino), values: first };
  } catch { return { target, path: directory, error: 'control-unreadable' }; }
});
process.stdout.write(JSON.stringify({ version: 1, scope: 'guest-cgroup', groups }));
`;

export function createPersonVmGuestMemoryReader(input: {
  binding: PersonVmBinding;
  name: string;
  command: NativeCommand;
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
  const { name, command } = input;
  const targets = input.targets.map((target) => Object.freeze({ ...target }));
  const root = input.cgroupRoot;
  const pathValid = (path: string) =>
    typeof path === 'string' &&
    posix.isAbsolute(path) &&
    posix.normalize(path) === path &&
    !path.includes('\0');
  if (
    !name ||
    /[\s\0]/.test(name) ||
    typeof command !== 'function' ||
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
      evidenceRef: `msb-exec:guest-cgroup:${revision}`,
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
  return {
    async read(bindingInput, signal) {
      signal.throwIfAborted();
      if (bindingKey(bindingInput) !== key)
        throw new PersonVmError('LEASE_LOST');
      try {
        const raw: unknown = JSON.parse(
          await command(
            [
              'exec',
              name,
              '--no-stdin',
              '--no-tty',
              '--',
              'node',
              '-e',
              PERSON_VM_GUEST_CONTROL_READER,
              JSON.stringify(
                targets.map(({ target, path }) => ({ target, path })),
              ),
            ],
            signal,
          ),
        );
        signal.throwIfAborted();
        if (
          !raw ||
          typeof raw !== 'object' ||
          !('version' in raw) ||
          raw.version !== 1 ||
          !('scope' in raw) ||
          raw.scope !== 'guest-cgroup' ||
          !('groups' in raw) ||
          !Array.isArray(raw.groups) ||
          raw.groups.length !== targets.length
        )
          return unknown('invalid-public-readback');
        const groups: PersonVmGuestControlReadback[] = [];
        for (const [index, target] of targets.entries()) {
          const group = raw.groups[index];
          if (
            !group ||
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
            const values = group.values.map(control);
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
      } catch {
        // Join the host CLI runner, never race abort against it. This alone is
        // not a guest job completion certificate; lifecycle wiring owns that.
        signal.throwIfAborted();
        return unknown('public-exec-unavailable');
      }
    },
  };
}
