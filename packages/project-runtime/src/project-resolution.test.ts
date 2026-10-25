import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ProjectDependencyResolveInputSchema,
  ProjectWorkspaceToolInputSchema,
  projectResolutionManifest,
  projectResolutionCloudArguments,
  CloudCommandSchema,
  cloudToolchainImageV1,
  sandboxExecutionBudgetSpec,
  resolveSandboxExecutionPolicy,
  RuntimeProjectPreparationSchema,
} from '@allrice/contracts';
import { readResolvedProject } from './project-resolution.js';

const request = ProjectDependencyResolveInputSchema.parse({
  action: 'resolve',
  manager: 'pnpm',
  packages: [{ name: 'is-number', version: '7.0.0' }],
});
const integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64');
const lock = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      is-number:
        specifier: 7.0.0
        version: 7.0.0
packages:
  is-number@7.0.0:
    resolution: {integrity: ${integrity}}
snapshots:
  is-number@7.0.0: {}
`;
const receipt = (text = lock) => ({
  version: 1,
  manager: 'pnpm',
  phase: 'lock_validation',
  status: 'resolved',
  exitCode: 0,
  diagnostics: '',
  lock: text,
});
const decode = (r: unknown) =>
  readResolvedProject(request, Buffer.from(JSON.stringify(r)));
const command = () => {
  const args = projectResolutionCloudArguments(request);
  return CloudCommandSchema.parse({
    capability: 'cloud.process.execute',
    backend: 'cloud-gvisor-v1',
    runtime: 'runsc',
    imageDigest: cloudToolchainImageV1,
    arguments: args,
    network: args.network,
    origin: {
      toolName: 'workspace.project',
      callId: 'resolve-1',
      purpose: 'project_dependency_resolution',
      argumentsDigest: 'sha256:' + 'a'.repeat(64),
      request,
    },
    executionBudget: sandboxExecutionBudgetSpec(
      { version: 1, kind: 'install' },
      resolveSandboxExecutionPolicy([]),
    ),
  });
};
describe('managed project resolution', () => {
  it('accepts declarations, not install commands or arbitrary input/config', () => {
    expect(ProjectWorkspaceToolInputSchema.parse(request)).toEqual(request);
    for (const bad of [
      { ...request, script: 'exec' },
      { ...request, files: [] },
      { ...request, url: 'https://example.com' },
      { ...request, packages: [{ name: '../escape', version: '1.0.0' }] },
      { ...request, packages: [{ name: 'is-number', version: '^7.0.0' }] },
      { ...request, packages: [...request.packages, ...request.packages] },
      {
        action: 'resolve',
        manager: 'uv',
        packages: [{ name: 'p', version: '1; rm -rf /' }],
      },
      {
        action: 'resolve',
        manager: 'uv',
        packages: [
          { name: 'Foo_Bar', version: '1.0' },
          { name: 'foo-bar', version: '2.0' },
        ],
      },
    ])
      expect(() => ProjectWorkspaceToolInputSchema.parse(bad)).toThrow();
  });
  it('binds a fixed controller and renewable platform budget; neither can be changed by the caller', () => {
    const c = command();
    expect(c.executionBudget?.policy.maxExecutionMs).toBe(600000);
    for (const bad of [
      { ...c, executionBudget: undefined },
      { ...c, arguments: { ...c.arguments, script: 'console.log(1)' } },
      {
        ...c,
        arguments: {
          ...c.arguments,
          inputs: [
            {
              objectId: '00000000-0000-4000-8000-000000000001',
              checksum: 'sha256:' + 'a'.repeat(64),
              path: 'secret',
            },
          ],
        },
      },
      {
        ...c,
        arguments: {
          ...c.arguments,
          limits: { ...c.arguments.limits, memoryMiB: 256 },
        },
      },
    ])
      expect(() => CloudCommandSchema.parse(bad)).toThrow();
  });
  it('returns a deterministic saved manifest/preparation, never an installation claim', () => {
    const r = decode(receipt());
    const prep = r.forProject!('00000000-0000-4000-8000-000000000001');
    expect(r.files?.[0]).toEqual(projectResolutionManifest(request));
    expect(prep).toMatchObject({
      manager: 'pnpm',
      packages: [{ name: 'is-number', version: '7.0.0', integrity }],
      scripts: 'disabled',
      offline: false,
    });
    expect(prep.sourceDigest).toBe(
      'sha256:' +
        createHash('sha256')
          .update(
            JSON.stringify(
              r.files!.map((f) => ({
                path: f.path,
                sha256:
                  'sha256:' + createHash('sha256').update(f.text).digest('hex'),
              })),
            ),
          )
          .digest('hex'),
    );
    expect('installed' in r).toBe(false);
  });
  it('rejects altered direct versions, duplicate keys, aliases and tarball sources', () => {
    for (const text of [
      lock.replace('specifier: 7.0.0', 'specifier: 6.0.0'),
      lock.replace('version: 7.0.0', 'version: 6.0.0'),
      lock.replace(
        'resolution: {integrity:',
        'resolution: {tarball: https://evil.invalid/p, integrity:',
      ),
      lock + 'packages: {}\n',
      lock.replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'"),
      lock.replace('integrity: ' + integrity, 'integrity: sha512-bad'),
    ])
      expect(() => decode(receipt(text))).toThrow();
  });
  it('requires the explicit cloud web profile above 128 dependencies, with a hard 256 limit', () => {
    const largeLock = (count: number) =>
      lock.replace(
        'snapshots:\n',
        Array.from(
          { length: count - 1 },
          (_, i) =>
            `  extra-${i}@1.0.0:\n    resolution: {integrity: ${integrity}}\n`,
        ).join('') + 'snapshots:\n',
      );
    const read = (count: number, web = false) =>
      readResolvedProject(
        {
          ...request,
          ...(web ? { resourceProfile: 'web-development' as const } : {}),
        },
        Buffer.from(JSON.stringify(receipt(largeLock(count)))),
      );
    expect(read(128).forProject).toBeTypeOf('function');
    expect(() => read(129)).toThrow('PROJECT_RESOLUTION_LIMIT');
    const spec = read(256, true).forProject!(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(spec.packages).toHaveLength(256);
    expect(
      RuntimeProjectPreparationSchema.safeParse({
        ...spec,
        resourceProfile: 'standard',
      }).success,
    ).toBe(false);
    expect(() => read(257, true)).toThrow('PROJECT_RESOLUTION_LIMIT');
  });
  it('preserves failed package-manager receipts without generating source/preparation', () => {
    const failure = {
      version: 1,
      manager: 'pnpm',
      phase: 'resolve',
      status: 'failed',
      exitCode: 1,
      errorCode: 'PROJECT_RESOLUTION_PACKAGE_FAILED',
      diagnostics: 'No matching version',
    };
    expect(decode(failure)).toEqual({ receipt: failure });
    expect(() => decode({ ...failure, exitCode: 0 })).toThrow();
    expect(() => decode({ ...failure, lock })).toThrow();
  });
  it('validates Python wheels with the existing independent installer, including hash and path agreement', () => {
    const args = ProjectDependencyResolveInputSchema.parse({
      action: 'resolve',
      manager: 'uv',
      packages: [{ name: 'six', version: '1.17.0' }],
    });
    const sum = 'a'.repeat(64),
      fileName = 'six-1.17.0-py2.py3-none-any.whl';
    const r = {
      version: 1,
      manager: 'uv',
      phase: 'lock_validation',
      status: 'resolved',
      exitCode: 0,
      diagnostics: '',
      lock: `six==1.17.0 --hash=sha256:${sum}\n`,
      wheels: [
        {
          name: 'six',
          version: '1.17.0',
          fileName,
          url: `https://files.pythonhosted.org/packages/aa/bb/${fileName}`,
          sha256: 'sha256:' + sum,
        },
      ],
    };
    const read = (v: unknown) =>
      readResolvedProject(args, Buffer.from(JSON.stringify(v)));
    expect(
      read(r).forProject!('00000000-0000-4000-8000-000000000001'),
    ).toMatchObject({ manager: 'uv', scripts: 'disabled' });
    for (const wheels of [
      [{ ...r.wheels[0], sha256: 'sha256:' + 'b'.repeat(64) }],
      [{ ...r.wheels[0], url: 'https://evil.invalid/' + fileName }],
      [{ ...r.wheels[0], fileName: 'other.whl' }],
      r.wheels.concat(r.wheels),
    ])
      expect(() => read({ ...r, wheels })).toThrow();
  });
  it('accepts only wheels that install on the requested CPU', () => {
    const x86 =
        'numpy-2.2.6-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
      sum = 'c'.repeat(64);
    const receipt = {
      version: 1,
      manager: 'uv',
      phase: 'lock_validation',
      status: 'resolved',
      exitCode: 0,
      diagnostics: '',
      lock: `numpy==2.2.6 --hash=sha256:${sum}\n`,
      wheels: [
        {
          name: 'numpy',
          version: '2.2.6',
          fileName: x86,
          url: `https://files.pythonhosted.org/packages/aa/bb/${x86}`,
          sha256: 'sha256:' + sum,
        },
      ],
    };
    const read = (architecture: 'amd64' | 'arm64') =>
      readResolvedProject(
        ProjectDependencyResolveInputSchema.parse({
          action: 'resolve',
          manager: 'uv',
          packages: [{ name: 'numpy', version: '2.2.6' }],
          architecture,
        }),
        Buffer.from(JSON.stringify(receipt)),
      );
    expect(read('amd64').forProject).toBeTypeOf('function');
    expect(() => read('arm64')).toThrow();
  });
});
