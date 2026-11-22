// Guest-only cooperative resource setup. Importing this module is inert.
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');

function initialize(config, io = fs, run = cp.execFileSync) {
  if (config.contractVersion !== 1) throw Error('memory_contract_unsupported');
  if (typeof config.policyRef !== 'string' || !config.policyRef.trim())
    throw Error('approved_memory_policy_required');
  const { cgroupRoot, dshGroup, commandsGroup, swapFile, procRoot, policy } =
    config;
  for (const value of [cgroupRoot, dshGroup, commandsGroup, swapFile, procRoot])
    if (
      typeof value !== 'string' ||
      !path.isAbsolute(value) ||
      /[\s\0]/.test(value)
    )
      throw Error('invalid_memory_path');
  if (
    path.dirname(dshGroup) !== cgroupRoot ||
    path.dirname(commandsGroup) !== cgroupRoot ||
    dshGroup === commandsGroup
  )
    throw Error('invalid_memory_groups');
  const values = [
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
    !values.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !scores.every(
      (value) => Number.isInteger(value) && value >= -1000 && value <= 1000,
    ) ||
    policy.physicalBytes !== 2147483648 ||
    !(policy.swapBytes > 0) ||
    policy.commandHighBytes > policy.commandMaxBytes ||
    policy.commandOomGroup !== 0
  )
    throw Error('invalid_memory_policy');
  const read = (file) => io.readFileSync(file, 'utf8').trim();
  const write = (file, value) => io.writeFileSync(file, String(value));
  const activeSwap = () =>
    read(path.join(procRoot, 'swaps'))
      .split('\n')
      .slice(1)
      .some((line) => line.split(/\s+/)[0] === swapFile);
  io.mkdirSync(path.dirname(swapFile), { recursive: true, mode: 0o700 });
  let stat;
  try {
    stat = io.lstatSync(swapFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (
    stat &&
    (!stat.isFile() || stat.isSymbolicLink() || stat.size !== policy.swapBytes)
  )
    throw Error('existing_swap_file_invalid');
  if (!stat) {
    run('fallocate', ['-l', String(policy.swapBytes), swapFile]);
    io.chmodSync(swapFile, 0o600);
    run('mkswap', [swapFile]);
  }
  io.chmodSync(swapFile, 0o600);
  if (!activeSwap()) run('swapon', [swapFile]);
  if (!activeSwap()) throw Error('swap_activation_not_observed');
  write(path.join(cgroupRoot, 'cgroup.subtree_control'), '+memory');
  const groups = {
    [dshGroup]: {
      'memory.low': policy.dshLowBytes,
      'memory.high': 'max',
      'memory.max': 'max',
      'memory.swap.max': policy.dshSwapMaxBytes,
    },
    [commandsGroup]: {
      'memory.high': policy.commandHighBytes,
      'memory.max': policy.commandMaxBytes,
      'memory.swap.max': policy.commandSwapMaxBytes,
      'memory.oom.group': policy.commandOomGroup,
    },
  };
  // Initial setup is owned by the starting VM lifecycle, before DSH launch.
  // This module cannot establish that host fence. Existing groups are never
  // reconfigured: populated=0 alone cannot exclude a new command joining.
  const pendingLimits = [];
  for (const [group, limits] of Object.entries(groups)) {
    let created = true;
    try {
      io.mkdirSync(group);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      created = false;
    }
    const populated = read(path.join(group, 'cgroup.events'))
      .split('\n')
      .find((line) => line.split(/\s+/)[0] === 'populated')
      ?.split(/\s+/)[1];
    if (populated !== '0' && populated !== '1')
      throw Error('memory_group_population_unknown');
    // cgroup.events includes descendants; cgroup.procs is only a conservative
    // extra check and must never be used to infer an empty subtree.
    const live =
      populated === '1' || read(path.join(group, 'cgroup.procs')) !== '';
    for (const [name, value] of Object.entries(limits)) {
      let current;
      try {
        current = read(path.join(group, name));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (current === String(value)) continue;
      if (live) throw Error('memory_group_has_live_processes');
      if (!created) throw Error('memory_group_reconfiguration_unsupported');
      pendingLimits.push([path.join(group, name), value]);
    }
  }
  // Preflight every group before changing any limit. No running reconfigure
  // path is offered; a startup owner fence must cover new-group check + write.
  for (const [file, value] of pendingLimits) write(file, value);
  const observed = {};
  for (const [group, limits] of Object.entries(groups)) {
    observed[group] = {};
    for (const [name, value] of Object.entries(limits)) {
      const actual = read(path.join(group, name));
      if (actual !== String(value)) throw Error('memory_limit_readback_failed');
      observed[group][name] = actual;
    }
  }
  let enabled = '';
  try {
    enabled = read(path.join(commandsGroup, 'cgroup.subtree_control'));
  } catch {
    /* write below */
  }
  if (!enabled.split(/\s+/).includes('memory'))
    write(path.join(commandsGroup, 'cgroup.subtree_control'), '+memory');
  if (
    !read(path.join(commandsGroup, 'cgroup.subtree_control'))
      .split(/\s+/)
      .includes('memory')
  )
    throw Error('command_memory_subtree_not_enabled');
  return {
    contractVersion: 1,
    policyRef: config.policyRef,
    swapFileBytes: io.statSync(swapFile).size,
    swaps: read(path.join(procRoot, 'swaps')),
    groups: observed,
    boundary: 'guest-root-cooperative-not-security-isolation',
  };
}
module.exports = { initialize };
if (require.main === module) {
  try {
    if (process.platform !== 'linux' || process.getuid() !== 0)
      throw Error('guest_linux_root_required');
    const result = initialize(
      JSON.parse(fs.readFileSync(process.argv[2], 'utf8')),
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write('VM_MEMORY_SETUP_FAILED: ' + error.message + '\n');
    process.exitCode = 75;
  }
}
