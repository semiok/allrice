import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import {
  VM_MEMORY_CONTRACT_VERSION,
  VM_PHYSICAL_MEMORY_BYTES,
} from './contract.ts';
import type { VmMemoryPolicy } from './contract.ts';

export type VmMemoryGuestPlan = Readonly<{
  /** Stage only into this person's encrypted persistent disk, never the host. */
  files: readonly Readonly<{ path: string; contents: string; mode: number }>[];
  initialize: Readonly<{ executable: 'node'; args: readonly string[] }>;
  /** Execute this launcher BEFORE native DSH. It joins the protected group and
   * sets oom_score_adj before exec, avoiding a post-spawn placement race. */
  launcher: string;
  env: Readonly<Record<string, string>>;
}>;

/** Produces inert artifacts. No subprocess, VM boot or cgroup mutation occurs.
 * MET-266's runtime owner must stage/init before authenticated DSH readiness. */
export async function createVmMemoryGuestPlan(input: {
  persistentDirectory: string;
  /** Host platform configuration; no phase4 fallback or guest-selected limits. */
  policy: VmMemoryPolicy;
  /** Actual approval/config release reference, not permission granted by a string. */
  policyRef: string;
}): Promise<VmMemoryGuestPlan> {
  if (typeof input.policyRef !== 'string' || !input.policyRef.trim())
    throw new Error('approved_memory_policy_required');
  const policy = { ...input.policy };
  const byteValues = [
    policy.physicalBytes,
    policy.swapBytes,
    policy.dshLowBytes,
    policy.dshSwapMaxBytes,
    policy.commandHighBytes,
    policy.commandMaxBytes,
    policy.commandSwapMaxBytes,
  ];
  const scores = [policy.dshOomScoreAdj, policy.commandOomScoreAdj];
  if (
    !byteValues.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !scores.every(
      (value) => Number.isInteger(value) && value >= -1000 && value <= 1000,
    ) ||
    policy.physicalBytes !== VM_PHYSICAL_MEMORY_BYTES ||
    !(policy.swapBytes > 0) ||
    policy.commandOomGroup !== 0 ||
    policy.commandHighBytes > policy.commandMaxBytes
  )
    throw new Error('invalid_memory_policy');
  const root = normalize(input.persistentDirectory);
  if (
    !isAbsolute(root) ||
    root === '/' ||
    /\s/.test(root) ||
    root.includes('\0')
  )
    throw new Error('invalid_guest_memory_directory');
  const directory = join(root, 'allrice-memory');
  const cgroupRoot = '/sys/fs/cgroup';
  const dshGroup = join(cgroupRoot, 'allrice-dsh');
  const commandsGroup = join(cgroupRoot, 'allrice-commands');
  const config = {
    contractVersion: VM_MEMORY_CONTRACT_VERSION,
    cgroupRoot,
    dshGroup,
    commandsGroup,
    swapFile: join(directory, 'swapfile'),
    procRoot: '/proc',
    policy,
    policyRef: input.policyRef,
  };
  const names = [
    'initialize.cjs',
    'bash-env.sh',
    'launch-dsh.sh',
    'sample.cjs',
  ];
  const files = await Promise.all(
    names.map(async (name) => ({
      path: join(directory, name),
      contents: await readFile(
        new URL(`../guest/${name}`, import.meta.url),
        'utf8',
      ),
      mode: 0o700,
    })),
  );
  files.push({
    path: join(directory, 'config.json'),
    contents: JSON.stringify(config) + '\n',
    mode: 0o600,
  });
  return {
    files,
    initialize: {
      executable: 'node',
      args: [join(directory, 'initialize.cjs'), join(directory, 'config.json')],
    },
    launcher: join(directory, 'launch-dsh.sh'),
    env: {
      BASH_ENV: join(directory, 'bash-env.sh'),
      ALLRICE_MEMORY_CGROUP_ROOT: cgroupRoot,
      ALLRICE_MEMORY_DSH_GROUP: dshGroup,
      ALLRICE_MEMORY_COMMANDS_GROUP: commandsGroup,
      ALLRICE_MEMORY_COMMAND_HIGH: String(policy.commandHighBytes),
      ALLRICE_MEMORY_COMMAND_MAX: String(policy.commandMaxBytes),
      ALLRICE_MEMORY_COMMAND_SWAP_MAX: String(policy.commandSwapMaxBytes),
      ALLRICE_MEMORY_COMMAND_OOM_SCORE: String(policy.commandOomScoreAdj),
      ALLRICE_MEMORY_DSH_OOM_SCORE: String(policy.dshOomScoreAdj),
      ALLRICE_MEMORY_PROC_ROOT: '/proc',
    },
  };
}
