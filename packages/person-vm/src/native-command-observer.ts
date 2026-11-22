import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { PersonVmError, type PersonVmBinding } from './contract.ts';
import type {
  PersonVmGuestCommand,
  PersonVmManagedJob,
} from './guest-bootstrap.ts';
import type { bootstrapMicrosandbox } from './microsandbox-bootstrap.ts';

/** Add stdout to the existing managed job, not a second guest executor.
 * Launch settlement must hand back a retained job or report owner cleanup
 * failure. Killing only the host CLI is not cancellation of this capability. */
export interface PersonVmManagedProbeJob extends PersonVmManagedJob {
  stdout(signal: AbortSignal): Promise<string>;
}
export interface PersonVmManagedProbePort {
  launch(
    command: PersonVmGuestCommand,
    signal: AbortSignal,
  ): Promise<PersonVmManagedProbeJob>;
}
/** Supplied by the real native command owner. A job ID alone is not a DSH
 * command-child association. The execution nonce is installed before dispatch;
 * The observer separately reads PID/generation from this exact native job. */
export type PersonVmNativeCommandExecution = Readonly<{
  job: PersonVmManagedJob;
  executionRef: string;
}>;
type Events = Readonly<{ oom: string; oomKill: string }>;
export type PersonVmCommandMemoryCompletion = Readonly<{
  binding: PersonVmBinding;
  executionRef: string;
  jobId: string;
  runtimeBootId: string | null;
  scope: 'guest-command-cgroup';
  boundary: 'guest-root-cooperative';
  revision: string;
  state: 'complete' | 'unknown';
  reason: string | null;
  outcome:
    | 'command-memory-limit'
    | 'oom-killed-cause-unknown'
    | 'no-oom-evidence'
    | 'unknown';
  completion: Readonly<{
    joined: true;
    exitCode: number;
    timedOut: boolean;
    signal: number | null | 'unknown';
  }> | null;
  child: Readonly<{
    path: string;
    device: string;
    inode: string;
    bootId: string;
    startTicks: string;
    baseline: Events;
    after: Events;
    delta: Events;
    /** Actual empty cgroup.procs and populated=0, not just native job wait. */
    joined: true;
    released: true;
  }> | null;
}>;

/** Baseline/admitted writes its explicit receipt; complete is read-only.
 * Already-admitted same-birth reentry only verifies the original receipt.
 * Complete-and-release removes only the verified empty child and its receipt.
 * Each phase checks real cgroup2 and canonical identity. No process migration,
 * kill, limit mutation or parent OOM count. Guest root can still forge it. */
export const PERSON_VM_COMMAND_MEMORY_PROGRAM = String.raw`
const fs = require('node:fs'), path = require('node:path').posix;
const cfg = JSON.parse(process.argv[1]), phase = process.argv[2];
let stage = 'read';
const fail = reason => { throw new Error(reason); };
const decimal = x => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x);
const canonical = p => typeof p === 'string' && p.startsWith('/') && p !== '/' && path.normalize(p) === p && !p.includes('\0') && fs.realpathSync(p) === p;
const read = (p, device) => {
  if (!canonical(p)) fail('noncanonical-file');
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || (device !== undefined && String(st.dev) !== device)) fail('invalid-file-identity');
    return fs.readFileSync(fd, 'utf8').trim();
  } finally { fs.closeSync(fd); }
};
const directory = p => {
  if (!canonical(p)) fail('noncanonical-directory');
  const st = fs.statSync(p, { bigint: true });
  if (!st.isDirectory() || fs.statfsSync(p, { bigint: true }).type !== 0x63677270n) fail('not-cgroup2');
  return { device: String(st.dev), inode: String(st.ino) };
};
const events = (p, device) => {
  const lines = read(path.join(p, 'memory.events'), device).split('\n');
  const count = name => {
    const rows = lines.filter(line => line.split(/\s+/)[0] === name);
    const pair = rows.length === 1 && rows[0].split(/\s+/);
    if (!pair || pair.length !== 2 || !decimal(pair[1])) fail('invalid-memory-events');
    return pair[1];
  };
  return { oom: count('oom'), oomKill: count('oom_kill') };
};
const members = (p, device) => {
  const text = read(path.join(p, 'cgroup.procs'), device);
  const values = text ? text.split('\n') : [];
  if (values.some(x => !/^[1-9][0-9]*$/.test(x)) || new Set(values).size !== values.length) fail('invalid-members');
  return values;
};
const populated = (p, device) => {
  const rows = read(path.join(p, 'cgroup.events'), device).split('\n').filter(line => line.split(/\s+/)[0] === 'populated');
  const pair = rows.length === 1 && rows[0].split(/\s+/);
  if (!pair || pair.length !== 2 || !/^[01]$/.test(pair[1])) fail('invalid-populated');
  return Number(pair[1]);
};
try {
  if (!['baseline', 'admitted', 'complete', 'complete-and-release'].includes(phase) || typeof cfg.executionRef !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cfg.executionRef) || !Number.isSafeInteger(cfg.pid) || cfg.pid <= 0) fail('invalid-request');
  const root = directory(cfg.cgroupRoot), commands = directory(cfg.commandsGroup), dsh = directory(cfg.dshGroup);
  if (![cfg.commandsGroup, cfg.dshGroup].every(p => p.startsWith(cfg.cgroupRoot + '/')) || commands.device !== root.device || dsh.device !== root.device) fail('invalid-group-root');
  if (!canonical(cfg.receiptDirectory) || !fs.statSync(cfg.receiptDirectory).isDirectory() || !canonical(cfg.procRoot) || fs.statfsSync(cfg.procRoot, { bigint: true }).type !== 0x9fa0n) fail('invalid-source-root');
  const childPath = path.join(cfg.commandsGroup, 'command-' + cfg.pid);
  const child = directory(childPath);
  if (child.device !== root.device) fail('different-cgroup-device');
  const receiptPath = path.join(cfg.receiptDirectory, cfg.executionRef + '.json');
  const bootId = read(path.join(cfg.procRoot, 'sys/kernel/random/boot_id'));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId)) fail('invalid-boot-id');
  const birth = () => {
    const stat = read(path.join(cfg.procRoot, String(cfg.pid), 'stat'));
    if (!stat.startsWith(cfg.pid + ' (') || !stat.includes(') ')) fail('invalid-process-stat');
    const ticks = stat.slice(stat.lastIndexOf(') ') + 2).split(/\s+/)[19];
    if (!decimal(ticks)) fail('invalid-process-birth');
    return ticks;
  };
  const membership = () => {
    const rows = read(path.join(cfg.procRoot, String(cfg.pid), 'cgroup')).split('\n').filter(line => line.startsWith('0::'));
    if (rows.length !== 1) fail('invalid-membership');
    return rows[0].slice(3);
  };
  let receipt;
  if (phase === 'baseline') {
    if (members(childPath, child.device).length || populated(childPath, child.device) !== 0) fail('child-not-independent');
    const current = membership(), startTicks = birth();
    if (current !== cfg.dshGroup.slice(cfg.cgroupRoot.length)) fail('baseline-membership-mismatch');
    const baseline = events(childPath, child.device);
    if (members(childPath, child.device).length || populated(childPath, child.device) !== 0 || birth() !== startTicks) fail('baseline-changed');
    receipt = { version: 1, executionRef: cfg.executionRef, pid: cfg.pid, bootId, startTicks, child: { path: childPath, ...child }, baseline, beforeMembership: current, stage: 'baseline' };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  } else {
    receipt = JSON.parse(read(receiptPath));
    if (receipt.version !== 1 || receipt.executionRef !== cfg.executionRef || receipt.pid !== cfg.pid || receipt.bootId !== bootId || !decimal(receipt.startTicks) || receipt.child?.path !== childPath || receipt.child?.device !== child.device || receipt.child?.inode !== child.inode || receipt.beforeMembership !== cfg.dshGroup.slice(cfg.cgroupRoot.length) || !decimal(receipt.baseline?.oom) || !decimal(receipt.baseline?.oomKill)) fail('receipt-identity-mismatch');
    if (phase === 'admitted') {
      const admitted = members(childPath, child.device), alreadyAdmitted = receipt.stage === 'admitted';
      if ((!alreadyAdmitted && receipt.stage !== 'baseline') || (alreadyAdmitted && receipt.admittedMembership !== childPath.slice(cfg.cgroupRoot.length)) || birth() !== receipt.startTicks || membership() !== childPath.slice(cfg.cgroupRoot.length) || populated(childPath, child.device) !== 1 || !admitted.includes(String(cfg.pid)) || admitted.some(pid => pid !== String(cfg.pid) && pid !== String(process.pid))) fail('admitted-membership-mismatch');
      if (!alreadyAdmitted) {
        receipt = { ...receipt, stage: 'admitted', admittedMembership: membership() };
        const fd = fs.openSync(receiptPath, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
        try { if (!fs.fstatSync(fd).isFile()) fail('invalid-receipt-file'); fs.writeFileSync(fd, JSON.stringify(receipt)); }
        finally { fs.closeSync(fd); }
      }
    } else {
      if (receipt.stage !== 'admitted' || receipt.admittedMembership !== childPath.slice(cfg.cgroupRoot.length)) fail('dispatch-not-witnessed');
      try { fs.statSync(path.join(cfg.procRoot, String(cfg.pid))); fail('command-process-not-gone'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (members(childPath, child.device).length || populated(childPath, child.device) !== 0) fail('child-not-joined');
      const after = events(childPath, child.device), again = events(childPath, child.device), identity = directory(childPath);
      if (after.oom !== again.oom || after.oomKill !== again.oomKill || identity.device !== child.device || identity.inode !== child.inode || members(childPath, child.device).length || populated(childPath, child.device) !== 0) fail('completion-changed');
      if (BigInt(after.oom) < BigInt(receipt.baseline.oom) || BigInt(after.oomKill) < BigInt(receipt.baseline.oomKill)) fail('counter-reset');
      if (phase === 'complete-and-release') {
        stage = 'cleanup';
        fs.rmdirSync(childPath);
        fs.unlinkSync(receiptPath);
      }
      process.stdout.write(JSON.stringify({ version: 1, receipt, after, childJoined: true, childReleased: phase === 'complete-and-release' }));
    }
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ version: 1, stage, error: error instanceof Error ? error.message : 'probe-unavailable' }));
  process.exitCode = 1;
}
`;

const bindingKey = (binding: PersonVmBinding) =>
  JSON.stringify([
    binding.vmId,
    binding.personId,
    binding.organizationId,
    binding.instanceId,
    binding.leaseEpoch,
  ]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const decimal = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const path = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  value !== '/' &&
  posix.normalize(value) === value &&
  !value.includes('\0');

export function createPersonVmCommandMemoryObserver(input: {
  binding: PersonVmBinding;
  nodeExecutable: string;
  probes: PersonVmManagedProbePort;
  native: Readonly<{
    name: string;
    command: Parameters<typeof bootstrapMicrosandbox>[0]['command'];
  }>;
  cgroupRoot: string;
  commandsGroup: string;
  dshGroup: string;
  procRoot: string;
  receiptDirectory: string;
  /** Existing owner's explicit cleanup budget/signal, never the aborted read. */
  cleanupSignal(): AbortSignal;
}) {
  if (
    ![
      input.nodeExecutable,
      input.cgroupRoot,
      input.commandsGroup,
      input.dshGroup,
      input.procRoot,
      input.receiptDirectory,
    ].every(path) ||
    ![input.commandsGroup, input.dshGroup].every((value) =>
      value.startsWith(input.cgroupRoot + '/'),
    ) ||
    typeof input.probes?.launch !== 'function' ||
    typeof input.native?.command !== 'function' ||
    typeof input.native.name !== 'string' ||
    !input.native.name ||
    /[\s\0]/.test(input.native.name) ||
    typeof input.cleanupSignal !== 'function'
  )
    throw new PersonVmError('PROVIDER_FAILED');
  const { probes, cleanupSignal, nodeExecutable } = input;
  const native = Object.freeze({ ...input.native });
  const binding = Object.freeze({ ...input.binding });
  const expectedBinding = bindingKey(binding);
  const roots = Object.freeze({
    cgroupRoot: input.cgroupRoot,
    commandsGroup: input.commandsGroup,
    dshGroup: input.dshGroup,
    procRoot: input.procRoot,
    receiptDirectory: input.receiptDirectory,
  });

  function releasedChild(
    output: string,
    execution: PersonVmNativeCommandExecution & { pid: number },
  ): NonNullable<PersonVmCommandMemoryCompletion['child']> {
    const data: unknown = JSON.parse(output);
    if (!record(data) || !record(data.receipt))
      throw new Error('exact-child-release-unconfirmed');
    const receipt = data.receipt;
    const identity = receipt.child;
    const childPath = posix.join(
      roots.commandsGroup,
      `command-${execution.pid}`,
    );
    const { bootId, startTicks } = receipt;
    if (
      data.version !== 1 ||
      data.childJoined !== true ||
      data.childReleased !== true ||
      receipt.version !== 1 ||
      receipt.executionRef !== execution.executionRef ||
      receipt.pid !== execution.pid ||
      receipt.stage !== 'admitted' ||
      !record(identity) ||
      identity.path !== childPath ||
      !decimal(identity.device) ||
      !decimal(identity.inode) ||
      receipt.beforeMembership !==
        roots.dshGroup.slice(roots.cgroupRoot.length) ||
      receipt.admittedMembership !== childPath.slice(roots.cgroupRoot.length) ||
      typeof bootId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        bootId,
      ) ||
      !decimal(startTicks)
    )
      throw new Error('exact-child-release-unconfirmed');
    const events = (input: unknown): Events => {
      if (!record(input) || !decimal(input.oom) || !decimal(input.oomKill))
        throw new Error('exact-child-events-unavailable');
      return Object.freeze({ oom: input.oom, oomKill: input.oomKill });
    };
    const baseline = events(receipt.baseline),
      after = events(data.after);
    const oom = BigInt(after.oom) - BigInt(baseline.oom),
      oomKill = BigInt(after.oomKill) - BigInt(baseline.oomKill);
    if (oom < 0n || oomKill < 0n) throw new Error('counter-reset');
    return Object.freeze({
      path: childPath,
      device: identity.device,
      inode: identity.inode,
      bootId,
      startTicks,
      baseline,
      after,
      delta: Object.freeze({ oom: String(oom), oomKill: String(oomKill) }),
      joined: true,
      released: true,
    });
  }

  async function probe(
    execution: PersonVmNativeCommandExecution & { pid: number },
    signal: AbortSignal,
  ): Promise<NonNullable<PersonVmCommandMemoryCompletion['child']>> {
    let job: PersonVmManagedProbeJob;
    try {
      job = await probes.launch(
        {
          executable: nodeExecutable,
          args: [
            '-e',
            PERSON_VM_COMMAND_MEMORY_PROGRAM,
            JSON.stringify({
              ...roots,
              executionRef: execution.executionRef,
              pid: execution.pid,
            }),
            'complete-and-release',
          ],
        },
        signal,
      );
    } catch (cause) {
      // Dispatch may be ambiguous, and no child/receipt release is certified.
      throw new PersonVmError('CLEANUP_INCOMPLETE', { cause });
    }
    // A foreign returned handle cannot be killed to hide an ownership failure.
    if (
      !job ||
      !record(job.binding) ||
      bindingKey(job.binding) !== expectedBinding
    )
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    let joined = false;
    let releaseConfirmed = false;
    try {
      signal.throwIfAborted();
      if (!job.jobId || typeof job.stdout !== 'function')
        throw new PersonVmError('PROVIDER_FAILED');
      const result = await job.wait(signal);
      if (
        !Number.isInteger(result?.exitCode) ||
        typeof result?.timedOut !== 'boolean'
      )
        throw new PersonVmError('PROVIDER_FAILED');
      joined = true;
      const output = await job.stdout(signal);
      if (result.exitCode !== 0 || result.timedOut)
        throw new Error('release-probe-did-not-succeed');
      const child = releasedChild(output, execution);
      releaseConfirmed = true;
      // A fully validated certificate may arrive alongside cancellation. Keep
      // its release proof before propagating the caller's original reason.
      signal.throwIfAborted();
      return child;
    } catch (cause) {
      if (!joined) {
        try {
          const result = await job.cancelAndWait(cleanupSignal());
          if (
            !Number.isInteger(result?.exitCode) ||
            typeof result?.timedOut !== 'boolean'
          )
            throw new Error('unconfirmed-probe-cleanup');
          joined = true;
        } catch (cleanup) {
          throw new PersonVmError('CLEANUP_INCOMPLETE', {
            cause: new AggregateError([cause, cleanup]),
          });
        }
      }
      // Joining this probe does not prove its rmdir AND unlink completed. Do
      // not mask uncertain artifacts as unknown/abort or launch cleanup again.
      if (!releaseConfirmed)
        throw new PersonVmError('CLEANUP_INCOMPLETE', { cause });
      signal.throwIfAborted();
      throw cause;
    }
  }

  async function inspect(jobId: string, signal: AbortSignal) {
    const info = JSON.parse(
      await native.command(
        ['inspect', native.name, '--job', jobId, '--format', 'json'],
        signal,
      ),
    );
    signal.throwIfAborted();
    if (
      info?.version !== 1 ||
      info?.id !== jobId ||
      typeof info?.runtime_boot_id !== 'string' ||
      !info.runtime_boot_id.trim() ||
      !Number.isSafeInteger(info?.pid) ||
      info.pid <= 0 ||
      typeof info?.timed_out !== 'boolean' ||
      !['running', 'exited'].includes(info.state)
    )
      throw new Error('native-job-identity-unavailable');
    return Object.freeze({
      pid: info.pid as number,
      runtimeBootId: info.runtime_boot_id as string,
      state: info.state as string,
      exitCode: info.exit_code as unknown,
      timedOut: info.timed_out as boolean,
    });
  }

  return {
    async observeCompletion(
      bindingInput: PersonVmBinding,
      executionInput: PersonVmNativeCommandExecution,
      signal: AbortSignal,
    ): Promise<PersonVmCommandMemoryCompletion> {
      signal.throwIfAborted();
      const execution = Object.freeze({ ...executionInput });
      let completion: PersonVmCommandMemoryCompletion['completion'] = null;
      let child: PersonVmCommandMemoryCompletion['child'] = null;
      let runtimeBootId: string | null = null;
      let reason: string | null = null;
      let outcome: PersonVmCommandMemoryCompletion['outcome'] = 'unknown';
      try {
        if (
          bindingKey(bindingInput) !== expectedBinding ||
          bindingKey(execution.job.binding) !== expectedBinding ||
          !execution.job.jobId ||
          typeof execution.executionRef !== 'string' ||
          !/^[A-Za-z0-9_-]+$/.test(execution.executionRef)
        )
          throw new Error('execution-identity-unavailable');
        const before = await inspect(execution.job.jobId, signal);
        runtimeBootId = before.runtimeBootId;
        const result = await execution.job.wait(signal);
        signal.throwIfAborted();
        if (
          !Number.isInteger(result.exitCode) ||
          typeof result.timedOut !== 'boolean'
        )
          throw new Error('completion-unavailable');
        const afterNative = await inspect(execution.job.jobId, signal);
        if (
          afterNative.pid !== before.pid ||
          afterNative.runtimeBootId !== before.runtimeBootId ||
          afterNative.state !== 'exited' ||
          afterNative.exitCode !== result.exitCode ||
          afterNative.timedOut !== result.timedOut
        )
          throw new Error('native-job-identity-changed');
        const actualSignal: unknown =
          'signal' in result ? result.signal : undefined;
        const signalValue =
          actualSignal === null
            ? null
            : Number.isInteger(actualSignal) &&
                (actualSignal as number) >= 1 &&
                (actualSignal as number) <= 64
              ? (actualSignal as number)
              : 'unknown';
        completion = Object.freeze({
          joined: true,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          signal: signalValue,
        });
        child = await probe({ ...execution, pid: before.pid }, signal);
        const oom = BigInt(child.delta.oom),
          oomKill = BigInt(child.delta.oomKill);
        if (signalValue === 'unknown')
          reason = 'managed-terminating-signal-unavailable';
        else if (result.timedOut) reason = 'managed-timeout-cause-not-oom';
        else if (oom > 0n || oomKill > 0n)
          // Group events do not name a victim or tie its death to this exit.
          reason = 'group-oom-events-do-not-identify-command-victim';
        else if (signalValue === null && oomKill === 0n && oom === 0n)
          outcome = 'no-oom-evidence';
        else reason = 'completion-does-not-establish-oom';
      } catch (cause) {
        if (
          cause instanceof PersonVmError &&
          cause.code === 'CLEANUP_INCOMPLETE'
        )
          throw cause;
        signal.throwIfAborted();
        reason =
          cause instanceof Error ? cause.message : 'observation-unavailable';
      }
      const facts = {
        binding,
        executionRef: execution.executionRef,
        jobId: execution.job.jobId,
        runtimeBootId,
        scope: 'guest-command-cgroup' as const,
        boundary: 'guest-root-cooperative' as const,
        state:
          outcome === 'unknown' ? ('unknown' as const) : ('complete' as const),
        reason,
        outcome,
        completion,
        child,
      };
      return Object.freeze({
        ...facts,
        revision: createHash('sha256')
          .update(JSON.stringify(facts))
          .digest('hex'),
      });
    },
  };
}
