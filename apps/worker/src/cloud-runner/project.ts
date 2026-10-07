import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CloudProjectCommandSchema,
  CloudProjectRunResultSchema,
  RuntimeProjectPreparationEvidenceSchema,
  RuntimeProjectScopeSchema,
  projectRuntimeCacheIdentity,
  cloudProjectResultMatchesPayload,
  type CloudProjectCommand,
  type RuntimeProjectScope,
} from '@allrice/contracts';
import {
  type ProjectPreparation,
  ProjectEvents,
  readSavedProjectSource,
  validateProjectPreparation,
  projectStagingArchives,
  reserveProjectVolume,
  nodeProjectSupervisor,
  pythonProjectSupervisor,
  type ProjectEngine,
} from '@allrice/project-runtime';

const cacheLabel = 'xyz.bplabs.allrice.project.cache';
const payloadLabel = 'xyz.bplabs.allrice.project.payload';
const evidenceLabel = 'xyz.bplabs.allrice.project.evidence';
const ownerLabel = 'xyz.bplabs.allrice.project.fence-owner';
const deadlineLabel = 'xyz.bplabs.allrice.project.fence-deadline';
const fenceName = 'allrice-project-cache-fence';
const profileLabel = 'xyz.bplabs.allrice.project.profile';
function projectProfile(command: CloudProjectCommand) {
  const spec = command.arguments.projectPreparation;
  return spec.manager === 'pnpm'
    ? (spec.resourceProfile ?? 'standard')
    : 'standard';
}
const workOptions = (profile: 'standard' | 'web-development' = 'standard') => ({
  type: 'tmpfs',
  device: 'tmpfs',
  o: `size=${profile === 'web-development' ? 1024 : 128}m,nosuid,nodev,mode=0755`,
});
type Volume = {
  Name: string;
  Driver: string;
  Options: Record<string, string> | null;
  Labels: Record<string, string> | null;
};
export type CloudProjectContainer = {
  Id: string;
  Config: { Image?: string; Labels: Record<string, string> };
  Mounts?: { Type: string; Name: string; Destination: string }[];
  HostConfig?: {
    Runtime?: string;
    NetworkMode?: string;
    PortBindings?: Record<string, unknown>;
    Privileged?: boolean;
  };
  State: {
    Running: boolean;
    Status: string;
    ExitCode: number;
    OOMKilled: boolean;
    FinishedAt?: string;
  };
};
type Api = ProjectEngine & {
  inspect(attempt: string): Promise<CloudProjectContainer | null>;
  call(method: string, path: string, body?: unknown): Promise<Buffer>;
};
const payloadDigest = (c: CloudProjectCommand) =>
  createHash('sha256').update(JSON.stringify(c)).digest('hex');
const absent = (e: unknown) =>
  e instanceof Error && e.message === 'CLOUD_DAEMON_404';

/** One daemon-wide mutation/usage fence, including archive downloads and cache use.
 * Atomic Docker names protect multiple Workers; expiry alone never evicts live work. */
async function acquireCacheFence(
  api: Api,
  input: {
    attemptId: string;
    deadline: number;
    imageDigest: string;
    signal: AbortSignal;
    maintainLease: () => Promise<boolean>;
  },
) {
  while (Date.now() < input.deadline) {
    input.signal.throwIfAborted();
    if (!(await input.maintainLease())) throw Error('CLOUD_EXECUTION_REVOKED');
    try {
      const c = await api.json<{ Id: string }>(
        'POST',
        `/containers/create?name=${fenceName}`,
        {
          Image: input.imageDigest,
          Entrypoint: ['/usr/local/bin/node'],
          Cmd: ['--version'],
          NetworkDisabled: true,
          Labels: {
            [ownerLabel]: input.attemptId,
            [deadlineLabel]: String(input.deadline),
          },
          HostConfig: {
            Runtime: 'runsc',
            NetworkMode: 'none',
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            AutoRemove: false,
          },
        },
      );
      if (!/^[a-f0-9]{64}$/.test(c.Id)) throw Error('CLOUD_INVALID_CONTAINER');
      return {
        valid: async () => {
          try {
            return (
              (
                await api.json<{ Id: string }>(
                  'GET',
                  `/containers/${fenceName}/json`,
                )
              ).Id === c.Id && Date.now() < input.deadline
            );
          } catch (e) {
            if (absent(e)) return false;
            throw e;
          }
        },
        release: async () => {
          await api.call('DELETE', `/containers/${c.Id}?v=true`).catch((e) => {
            if (!absent(e)) throw e;
          });
        },
      };
    } catch (e) {
      if (!(e instanceof Error) || e.message !== 'CLOUD_DAEMON_409') throw e;
    }
    const old = await api
      .json<CloudProjectContainer>('GET', `/containers/${fenceName}/json`)
      .catch((e) => {
        if (absent(e)) return null;
        throw e;
      });
    const owner = old?.Config.Labels[ownerLabel],
      expires = Number(old?.Config.Labels[deadlineLabel]);
    if (
      old &&
      !old.State.Running &&
      owner &&
      /^[a-f0-9-]{36}$/.test(owner) &&
      Number.isFinite(expires) &&
      expires > 0 &&
      expires <= Date.now()
    ) {
      const physical = await api.inspect(owner);
      if (!physical?.State.Running) {
        // Delete created attempts before reclaiming the fence; delayed old starts must get 404.
        if (physical?.State.Status === 'created')
          await api
            .call('DELETE', `/containers/${physical.Id}?v=true`)
            .catch((e) => {
              if (!absent(e)) throw e;
            });
        await api.call('DELETE', `/containers/${old.Id}?v=true`).catch((e) => {
          if (!absent(e)) throw e;
        });
      }
    }
    await delay(150, undefined, { signal: input.signal });
  }
  throw Error('CLOUD_PROJECT_CACHE_WAIT_TIMEOUT');
}

async function inspectVolume(
  api: ProjectEngine,
  name: string,
  labels: Record<string, string>,
  work = false,
  profile: 'standard' | 'web-development' = 'standard',
) {
  const options = work ? workOptions(profile) : {};
  const v = await api.json<Volume>('GET', `/volumes/${name}`);
  if (
    v.Name !== name ||
    v.Driver !== 'local' ||
    Object.keys(v.Options ?? {}).length !== Object.keys(options).length ||
    Object.entries(options).some(([k, val]) => v.Options?.[k] !== val) ||
    Object.entries(labels).some(([k, val]) => v.Labels?.[k] !== val)
  )
    throw Error('PROJECT_CACHE_UNSAFE');
  return v;
}

export async function assertCloudProjectContainer(
  api: ProjectEngine,
  c: CloudProjectContainer,
  command?: CloudProjectCommand,
) {
  const profile = c.Config.Labels[profileLabel] ?? 'standard';
  if (
    !['standard', 'web-development'].includes(profile) ||
    (command && projectProfile(command) !== profile)
  )
    throw Error('CLOUD_CONTAINER_IDENTITY_CHANGED');
  if (c.Config.Labels['xyz.bplabs.allrice.cloud.kind'] !== 'project')
    throw Error('CLOUD_CONTAINER_IDENTITY_CHANGED');
  const attempt = c.Config.Labels['xyz.bplabs.allrice.cloud.attempt'],
    cache = c.Config.Labels[cacheLabel];
  const image =
    command?.imageDigest ?? c.Config.Labels['xyz.bplabs.allrice.project.image'];
  if (
    !attempt ||
    !/^sha256:[a-f0-9]{64}$/.test(cache ?? '') ||
    c.Config.Image !== image ||
    (command && c.Config.Labels[payloadLabel] !== payloadDigest(command)) ||
    !c.Mounts?.some(
      (m) =>
        m.Type === 'volume' &&
        m.Name === `allrice-project-work-${attempt}` &&
        m.Destination === '/tmp/work',
    ) ||
    !c.Mounts?.some(
      (m) =>
        m.Type === 'volume' &&
        m.Name === `allrice-project-cache-${cache!.slice(7)}` &&
        m.Destination === '/cache',
    ) ||
    c.Mounts?.some((m) => m.Type === 'bind')
  )
    throw Error('CLOUD_CONTAINER_IDENTITY_CHANGED');
  if (
    command?.arguments.background &&
    (c.HostConfig?.Runtime !== 'runsc' ||
      c.HostConfig.NetworkMode !== 'none' ||
      c.HostConfig.Privileged ||
      Object.keys(c.HostConfig.PortBindings ?? {}).length ||
      c.Config.Labels['xyz.bplabs.allrice.cloud.service'] !== 'project-v1')
  )
    throw Error('CLOUD_CONTAINER_IDENTITY_CHANGED');
  await inspectVolume(
    api,
    `allrice-project-work-${attempt}`,
    {
      'xyz.bplabs.allrice.cloud.attempt': attempt,
      [payloadLabel]: c.Config.Labels[payloadLabel]!,
    },
    true,
    profile as 'standard' | 'web-development',
  );
  await inspectVolume(api, `allrice-project-cache-${cache!.slice(7)}`, {
    [cacheLabel]: cache!,
    ...(profile === 'web-development' ? { [profileLabel]: profile } : {}),
  });
}

/** Preparation/staging plan only. CloudRunnerBackend owns slot/start/poll/stop/recovery. */
export async function prepareCloudProject(
  api: Api,
  preparation: ProjectPreparation,
  input: {
    command: CloudProjectCommand;
    scope: RuntimeProjectScope;
    attemptId: string;
    deadline: number;
    signal: AbortSignal;
    maintainLease: () => Promise<boolean>;
    serviceId?: string;
    previewHost?: string | null;
  },
) {
  const command = CloudProjectCommandSchema.parse(input.command),
    scope = RuntimeProjectScopeSchema.parse(input.scope);
  const bundle = readSavedProjectSource(command.arguments),
    spec = validateProjectPreparation(command, bundle.files);
  const profile = projectProfile(command);
  const cacheKey =
    'sha256:' +
    createHash('sha256')
      .update(
        JSON.stringify(
          projectRuntimeCacheIdentity({
            spec,
            scope,
            image: command.imageDigest,
            architecture: 'amd64',
          }),
        ),
      )
      .digest('hex');
  if (cacheKey !== command.arguments.projectSource.cacheKey)
    throw Error('PROJECT_CACHE_UNSAFE');
  const fence = await acquireCacheFence(api, {
    ...input,
    imageDigest: command.imageDigest,
  });
  const maintainLease = async () =>
    (await fence.valid()) && input.maintainLease();
  const revoked = new AbortController(),
    signal = AbortSignal.any([input.signal, revoked.signal]);
  let checking = false;
  const check = async () => {
    if (signal.aborted || !(await maintainLease())) {
      revoked.abort();
      throw Error('CLOUD_EXECUTION_REVOKED');
    }
  };
  const heartbeat = setInterval(() => {
    if (checking) return;
    checking = true;
    void check()
      .catch(() => revoked.abort())
      .finally(() => (checking = false));
  }, 500);
  const workVolume = `allrice-project-work-${input.attemptId}`,
    cacheVolume = `allrice-project-cache-${cacheKey.slice(7)}`;
  let workCreated = false;
  try {
    await check();
    const tool = await preparation.tool(
      spec.manager,
      'amd64',
      signal,
      spec.offline,
    );
    const prepared = await preparation.archives({
      command,
      files: bundle.files,
      scope,
      architecture: 'amd64',
      signal,
      maintainLease,
    });
    await check();
    await reserveProjectVolume(api, cacheVolume, profile);
    const evidence = {
      version: 1,
      projectId: spec.projectId,
      sourceDigest: spec.sourceDigest,
      lockChecksum: spec.lockChecksum,
      cacheKey,
      manager: spec.manager,
      managerVersion: spec.managerVersion,
      platform: 'linux-amd64',
      runtimeImage: command.imageDigest,
      packageCount: spec.packages.length,
      archiveHits: prepared.archiveHits,
      downloadedArchives: prepared.downloadedArchives,
      downloadedBytes: prepared.downloadedBytes,
      cacheVolume,
      sourceDirectoryModified: false,
      hostEnvironmentModified: false,
    };
    const labels = {
      'xyz.bplabs.allrice.cloud.attempt': input.attemptId,
      'xyz.bplabs.allrice.cloud.kind': 'project',
      'xyz.bplabs.allrice.backend': 'cloud-gvisor-v1',
      'xyz.bplabs.allrice.cloud.deadline': String(input.deadline),
      'xyz.bplabs.allrice.project.image': command.imageDigest,
      ...(command.arguments.background
        ? {
            'xyz.bplabs.allrice.cloud.service': 'project-v1',
            'xyz.bplabs.allrice.cloud.service-id': input.serviceId!,
          }
        : {}),
      [payloadLabel]: payloadDigest(command),
      [cacheLabel]: cacheKey,
      [evidenceLabel]: JSON.stringify(evidence),
      ...(profile === 'web-development' ? { [profileLabel]: profile } : {}),
    };
    for (const [name, volumeLabels, options] of [
      [
        cacheVolume,
        {
          [cacheLabel]: cacheKey,
          ...(profile === 'web-development' ? { [profileLabel]: profile } : {}),
        },
        {},
      ],
      [
        workVolume,
        {
          'xyz.bplabs.allrice.cloud.attempt': input.attemptId,
          [payloadLabel]: payloadDigest(command),
          ...(profile === 'web-development' ? { [profileLabel]: profile } : {}),
        },
        workOptions(profile),
      ],
    ] as const) {
      if (name === workVolume) {
        try {
          await api.json('GET', `/volumes/${name}`);
          throw Error('CLOUD_RECOVERY_REQUIRED');
        } catch (e) {
          if (!absent(e)) throw e;
        }
      }
      await api.json('POST', '/volumes/create', {
        Name: name,
        Driver: 'local',
        DriverOpts: options,
        Labels: volumeLabels,
      });
      await inspectVolume(
        api,
        name,
        volumeLabels,
        name === workVolume,
        profile,
      );
      if (name === workVolume) workCreated = true;
    }
    const archives = projectStagingArchives({
      command,
      files: bundle.files,
      tool,
      prepared,
      deadlineUnixMs: input.deadline,
      deadlineReason: 'timeout',
    });
    return {
      command,
      maintainLease,
      signal,
      archives,
      config: {
        Image: command.imageDigest,
        Entrypoint:
          spec.manager === 'pnpm'
            ? ['/usr/local/bin/node']
            : ['/opt/python/bin/python'],
        Cmd:
          spec.manager === 'pnpm'
            ? [
                '--input-type=module',
                '--eval',
                nodeProjectSupervisor,
                String(input.deadline),
              ]
            : ['-I', '-c', pythonProjectSupervisor, String(input.deadline)],
        User: '0:0',
        WorkingDir: '/tmp/work',
        Tty: false,
        OpenStdin: !!command.arguments.background,
        Env: command.arguments.background
          ? [
              'ALLRICE_SERVICE_ID=' + input.serviceId,
              'ALLRICE_SERVICE_ATTEMPT=' + input.attemptId,
              ...(input.previewHost
                ? ['ALLRICE_SERVICE_PREVIEW_HOST=' + input.previewHost]
                : []),
            ]
          : [],
        Labels: labels,
        HostConfig: {
          Runtime: 'runsc',
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          CapAdd: [
            'CHOWN',
            'FOWNER',
            'DAC_OVERRIDE',
            'SETUID',
            'SETGID',
            'KILL',
          ],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: command.arguments.limits.pids,
          Memory: command.arguments.limits.memoryMiB * 1024 ** 2,
          MemorySwap: command.arguments.limits.memoryMiB * 1024 ** 2,
          CpuPeriod: 100000,
          CpuQuota: command.arguments.limits.cpuMillis * 100,
          Mounts: [
            { Type: 'volume', Source: workVolume, Target: '/tmp/work' },
            { Type: 'volume', Source: cacheVolume, Target: '/cache' },
          ],
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=32m,mode=1777' },
          ShmSize: 8 * 1024 ** 2,
          LogConfig: {
            Type: 'json-file',
            Config: { 'max-size': '1m', 'max-file': '1' },
          },
          RestartPolicy: { Name: 'no' },
          AutoRemove: false,
          Ulimits: [
            { Name: 'nofile', Soft: 256, Hard: 256 },
            { Name: 'core', Soft: 0, Hard: 0 },
          ],
        },
      },
      release: async (createUncertain = false) => {
        clearInterval(heartbeat);
        if (createUncertain) return;
        const c = await api.inspect(input.attemptId);
        if (!c || c.State.Status === 'exited') await fence.release();
      },
    };
  } catch (error) {
    clearInterval(heartbeat);
    if (workCreated)
      await inspectVolume(
        api,
        workVolume,
        {
          'xyz.bplabs.allrice.cloud.attempt': input.attemptId,
          [payloadLabel]: payloadDigest(command),
        },
        true,
        profile,
      )
        .then(() => api.json('DELETE', `/volumes/${workVolume}`))
        .catch(() => undefined);
    await fence.release();
    throw error;
  }
}

export function collectCloudProject(
  c: CloudProjectContainer,
  command: CloudProjectCommand,
  text: Buffer,
  startedAt: number,
  reason:
    | 'completed'
    | 'canceled'
    | 'deadline'
    | 'output_limit'
    | 'oom'
    | 'failed'
    | 'unknown' = 'completed',
) {
  const events = new ProjectEvents(
    command.arguments.limits.outputBytes,
    undefined,
    command.arguments.outputs,
    command.arguments.background ? () => undefined : undefined,
  );
  events.push(text);
  const observed = events.finish();
  const installation: 'interrupted' | 'succeeded' | 'failed' =
    observed.exit?.installation ??
    (observed.stage === 'running' ? 'succeeded' : 'interrupted');
  if (c.State.OOMKilled) reason = 'oom';
  else if (observed.exit?.reason === 'canceled') reason = 'canceled';
  else if (reason === 'completed') {
    if (
      observed.exit?.reason === 'timeout' ||
      observed.exit?.reason === 'lease_lost' ||
      (c.State.ExitCode === 137 &&
        Date.parse(c.State.FinishedAt ?? '') >=
          Number(c.Config.Labels['xyz.bplabs.allrice.cloud.deadline']))
    )
      reason = 'deadline';
    else if (observed.exit?.reason === 'output_limit' || observed.truncated)
      reason = 'output_limit';
    else if (
      c.State.ExitCode !== 0 ||
      observed.exit?.reason !== 'exited' ||
      observed.exit?.code !== 0 ||
      installation !== 'succeeded'
    )
      reason = 'failed';
  }
  const proof = RuntimeProjectPreparationEvidenceSchema.parse({
    ...JSON.parse(c.Config.Labels[evidenceLabel]!),
    installation,
    savedSource: {
      project: command.arguments.projectSource.project,
      restoredDigest: observed.sourceDigest ?? null,
    },
  });
  const result = CloudProjectRunResultSchema.parse({
    containerId: c.Id,
    exitCode: c.State.ExitCode,
    stopped: true,
    reason,
    output: observed.combined,
    artifacts:
      reason === 'completed' && c.State.ExitCode === 0
        ? observed.artifacts
        : [],
    elapsedMs: Math.max(0, Date.now() - startedAt),
    imageDigest: command.imageDigest,
    projectPreparation: proof,
  });
  if (!cloudProjectResultMatchesPayload(command, result))
    throw Error('CLOUD_PROJECT_RECEIPT_CHANGED');
  return result;
}

/** Named volumes are not removed by DELETE container?v=true. Preserve unknown or in-use resources. */
export async function cleanupCloudProject(
  api: Api,
  attempt: string,
  c?: CloudProjectContainer | null,
) {
  const name = `allrice-project-work-${attempt}`;
  const v = await api.json<Volume>('GET', `/volumes/${name}`).catch((e) => {
    if (absent(e)) return null;
    throw e;
  });
  if (v) {
    const profile = v.Labels?.[profileLabel] ?? 'standard';
    if (
      !['standard', 'web-development'].includes(profile) ||
      v.Labels?.['xyz.bplabs.allrice.cloud.attempt'] !== attempt ||
      !v.Labels?.[payloadLabel] ||
      (c &&
        (v.Labels[payloadLabel] !== c.Config.Labels[payloadLabel] ||
          profile !== (c.Config.Labels[profileLabel] ?? 'standard')))
    )
      throw Error('CLOUD_CONTAINER_IDENTITY_CHANGED');
    await inspectVolume(
      api,
      name,
      {
        'xyz.bplabs.allrice.cloud.attempt': attempt,
        [payloadLabel]: v.Labels[payloadLabel]!,
      },
      true,
      profile as 'standard' | 'web-development',
    );
    await api.json('DELETE', `/volumes/${name}`);
  }
  const fence = await api
    .json<CloudProjectContainer>('GET', `/containers/${fenceName}/json`)
    .catch((e) => {
      if (absent(e)) return null;
      throw e;
    });
  if (fence?.Config.Labels[ownerLabel] === attempt && !fence.State.Running)
    await api.call('DELETE', `/containers/${fence.Id}?v=true`);
}
