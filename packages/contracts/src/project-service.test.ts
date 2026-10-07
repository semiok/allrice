import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CloudProjectCommandSchema,
  ProjectServiceStartInputSchema,
} from './project-execution.ts';
import { ProjectServiceConfigSchema } from './project-service.ts';
import { RuntimeLocalServiceConfigSchema } from './runtime-v2/local-service.ts';
import {
  RuntimeLocalCommandSchema,
  RuntimeLocalCommandToolInputSchema,
  localCommandToolchainImageV1,
} from './runtime-v2/local-command.ts';
import { cloudToolchainImageV1 } from './runtime-v2/cloud-command.ts';

const id = '11111111-1111-4111-8111-111111111111';
const digest = (s: string) =>
  'sha256:' + createHash('sha256').update(s).digest('hex');
const lock = "lockfileVersion: '9.0'\n";
const file = {
  path: 'pnpm-lock.yaml',
  sha256: digest(lock),
  sizeBytes: Buffer.byteLength(lock),
  contentBase64: Buffer.from(lock).toString('base64'),
};
const files = [{ path: file.path, sha256: file.sha256 }];
const sourceDigest = digest(JSON.stringify(files));
const snapshot = { version: 1, projectId: id, sourceDigest, files: [file] };
const project = {
  projectId: id,
  snapshot: {
    kind: 'artifact',
    id,
    checksum: digest(JSON.stringify(snapshot)),
  },
};
const projectSource = {
  version: 1,
  project,
  snapshot,
  architecture: 'amd64',
  cacheKey: digest('cache'),
  origin: {
    jobId: id,
    workerId: id,
    attempt: 1,
    leaseTokenDigest: 'a'.repeat(64),
  },
  executionOrigin: {
    toolName: 'workspace.project',
    callId: id,
    argumentsDigest: digest('arguments'),
    selectionId: id,
  },
};
function inputs(
  profile: 'standard' | 'web-development' | undefined,
  readinessTimeoutMs: number,
) {
  const service = {
    port: 4173,
    path: '/',
    leaseMs: 600_000,
    readinessTimeoutMs,
  };
  const background = {
    durationMs: 3_600_000,
    projectService: service,
    readiness: {
      kind: 'http',
      port: 4173,
      path: '/',
      timeoutMs: readinessTimeoutMs,
    },
    stdin: {
      mode: 'none',
      maxRequests: 1,
      maxBytes: 1,
      requestTimeoutMs: 1000,
    },
  };
  const command = {
    executable: '/usr/local/bin/node',
    args: ['server.mjs'],
    path: '.',
    projectPreparation: {
      version: 1,
      projectId: id,
      sourceDigest,
      lockChecksum: file.sha256,
      offline: true,
      manager: 'pnpm',
      managerVersion: '10.33.3',
      ...(profile ? { resourceProfile: profile } : {}),
      lockPath: file.path,
      scripts: 'disabled',
      packages: [],
    },
    limits: {
      timeoutMs: 60_000,
      outputBytes: 4096,
      memoryMiB: 512,
      cpuMillis: 1000,
      pids: 64,
    },
  };
  return {
    public: { action: 'service_start', project, ...command, service },
    tool: { project, ...command, background },
    local: {
      capability: 'local.process.execute',
      arguments: {
        ...command,
        background,
        projectSource,
        files,
        imageDigest: localCommandToolchainImageV1,
        isolation: 'local-vm-container-v1',
        network: 'none',
      },
    },
    cloud: {
      kind: 'project',
      capability: 'cloud.process.execute',
      arguments: {
        ...command,
        background,
        projectSource,
        files,
        imageDigest: cloudToolchainImageV1,
      },
      backend: 'cloud-gvisor-v1',
      imageDigest: cloudToolchainImageV1,
      runtime: 'runsc',
      network: 'none',
    },
  };
}

describe('explicit project readiness budget across public, tool and backend contracts', () => {
  const schemas = {
    public: ProjectServiceStartInputSchema,
    tool: RuntimeLocalCommandToolInputSchema,
    local: RuntimeLocalCommandSchema,
    cloud: CloudProjectCommandSchema,
  };
  for (const profile of [undefined, 'standard', 'web-development'] as const) {
    it.each([30_000, 30_001, 300_000, 300_001])(
      'validates profile=' +
        String(profile) +
        ', readiness=%s without widening ordinary execution',
      (ms) => {
        const fixture = inputs(profile, ms);
        const allowed =
          ms <= (profile === 'web-development' ? 300_000 : 30_000);
        for (const key of Object.keys(schemas) as (keyof typeof schemas)[]) {
          const parsed = schemas[key].safeParse(fixture[key]);
          expect(
            parsed.success,
            key + ': ' + (!parsed.success ? parsed.error.message : ''),
          ).toBe(allowed);
        }
      },
    );
  }
  it('keeps the existing default and rejects contradictory readiness copies', () => {
    expect(
      ProjectServiceConfigSchema.parse({ port: 4173 }).readinessTimeoutMs,
    ).toBe(30_000);
    const f = inputs('web-development', 300_000);
    const b = f.local.arguments.background;
    for (const readiness of [
      { ...b.readiness, path: '/other' },
      { ...b.readiness, timeoutMs: 30_000 },
    ])
      expect(
        RuntimeLocalServiceConfigSchema.safeParse({ ...b, readiness }).success,
      ).toBe(false);
    expect(
      RuntimeLocalServiceConfigSchema.safeParse({
        ...b,
        durationMs: 60_000,
        projectService: undefined,
      }).success,
    ).toBe(false);
  });
});
