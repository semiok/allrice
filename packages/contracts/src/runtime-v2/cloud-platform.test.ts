import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDependencyResolveInput } from '../project-dependency-resolution.ts';
import {
  cloudArchitectureTranslationProblem,
  cloudPlatforms,
  selectCloudArchitecture,
} from './cloud-platform.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// The suite may itself run under ALLRICE_CLOUD_ARCHITECTURE=arm64 (native
// VM tests), so every case pins the variable before re-importing modules.
async function load(architecture: string) {
  vi.stubEnv('ALLRICE_CLOUD_ARCHITECTURE', architecture);
  vi.resetModules();
  return {
    platform: await import('./cloud-platform.ts'),
    command: await import('./cloud-command.ts'),
    browser: await import('../static-browser.ts'),
    resolution: await import('../project-resolution-script.ts'),
  };
}

const profile = (p: (typeof cloudPlatforms)[keyof typeof cloudPlatforms]) => ({
  backend: 'cloud-gvisor-v1',
  imageDigest: p.images.node,
  architecture: p.architecture,
  runtime: 'runsc',
  runtimeVersion: 'release-20260831.0',
  runtimeChecksum: p.runtimeChecksum,
  network: 'none',
  maximumConcurrency: 1,
});

describe('cloud platform selection', () => {
  it('refuses a Rosetta-translated Node unless the architecture is explicit', () => {
    const translated = () => 'translated' as const,
      native = () => 'native' as const,
      unknown = () => ({ unknown: 'sysctl: permission denied' });
    expect(
      cloudArchitectureTranslationProblem({
        platform: 'darwin',
        translation: translated,
      }),
    ).toMatch(/Rosetta/);
    expect(
      cloudArchitectureTranslationProblem({
        platform: 'darwin',
        translation: unknown,
      }),
    ).toMatch(/Cannot tell.*permission denied/);
    expect(
      cloudArchitectureTranslationProblem({
        platform: 'darwin',
        translation: native,
      }),
    ).toBeNull();
    expect(
      cloudArchitectureTranslationProblem({
        platform: 'darwin',
        override: 'arm64',
        translation: translated,
      }),
    ).toBeNull();
    expect(
      cloudArchitectureTranslationProblem({
        platform: 'linux',
        translation: translated,
      }),
    ).toBeNull();
  });
  it('follows the host CPU unless explicitly overridden', () => {
    expect(selectCloudArchitecture(undefined, 'x64')).toBe('amd64');
    expect(selectCloudArchitecture('', 'arm64')).toBe('arm64');
    expect(selectCloudArchitecture(undefined, undefined)).toBe('amd64');
    expect(selectCloudArchitecture('amd64', 'arm64')).toBe('amd64');
    expect(selectCloudArchitecture('arm64', 'x64')).toBe('arm64');
  });

  it('keeps the existing amd64 toolchain byte-identical', async () => {
    const { platform, command, browser } = await load('amd64');
    expect(platform.cloudPlatform).toBe(platform.cloudPlatforms.amd64);
    expect(command.cloudToolchainImageV1).toBe(
      'sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5',
    );
    expect(command.cloudPythonImageV1).toBe(
      'sha256:d6a52afde3d7c99d8cba9c89ff5078a8e1b6a177f97512ff4facfa4f930fe38e',
    );
    expect(browser.staticBrowserImageV1).toBe(
      'sha256:e0ef9ce00e900780e7b34a876a38549eb83ba597c62cb7d22c4986af2b725c77',
    );
  });

  it('rejects unknown architectures instead of falling back', () => {
    expect(() => selectCloudArchitecture('x86_64')).toThrow();
    expect(() => selectCloudArchitecture('aarch64')).toThrow();
  });

  it('pins every arm64 artifact separately from amd64', () => {
    const { amd64, arm64 } = cloudPlatforms;
    for (const digest of [
      arm64.runtimeChecksum,
      ...Object.values(arm64.images),
    ])
      expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(arm64.images.node).toBe(amd64.images.node);
    expect(arm64.runtimeChecksum).not.toBe(amd64.runtimeChecksum);
    for (const key of ['python', 'office', 'staticBrowser'] as const)
      expect(arm64.images[key]).not.toBe(amd64.images[key]);
  });

  it('admits only the selected architecture profile', async () => {
    const amd = await load('amd64');
    expect(
      amd.command.CloudExecutionProfileSchema.safeParse(
        profile(cloudPlatforms.amd64),
      ).success,
    ).toBe(true);
    expect(
      amd.command.CloudExecutionProfileSchema.safeParse(
        profile(cloudPlatforms.arm64),
      ).success,
    ).toBe(false);

    const arm = await load('arm64');
    expect(arm.command.cloudPythonImageV1).toBe(
      cloudPlatforms.arm64.images.python,
    );
    expect(arm.browser.staticBrowserImageV1).toBe(
      cloudPlatforms.arm64.images.staticBrowser,
    );
    expect(
      arm.command.CloudExecutionProfileSchema.safeParse(
        profile(cloudPlatforms.arm64),
      ).success,
    ).toBe(true);
    expect(
      arm.command.CloudExecutionProfileSchema.safeParse(
        profile(cloudPlatforms.amd64),
      ).success,
    ).toBe(false);
  });

  it('keeps the original controller bytes for requests without a target CPU', async () => {
    // Stored resolution records (made before targets existed) are verified by
    // regenerating their script; these are the bytes of commit 11657e1a.
    const input: ProjectDependencyResolveInput = {
      action: 'resolve',
      manager: 'uv',
      packages: [{ name: 'six', version: '1.17.0' }],
    };
    const { createHash } = await import('node:crypto');
    const digest = (script: string) =>
      createHash('sha256').update(script).digest('hex');
    const amd = await load('amd64');
    const amdScript = amd.resolution.projectResolutionScript(input);
    expect(digest(amdScript)).toBe(
      '3f4f830a5a560f5b0ae3f041b40c449711ea7e7a479e44ca544d0b9941bf7cdb',
    );
    expect(amdScript).toContain('uv-x86_64-unknown-linux-gnu');
    const arm = await load('arm64');
    const armScript = arm.resolution.projectResolutionScript(input);
    expect(digest(armScript)).toBe(
      '36d2734963870721813ad489accf0a19f4627ead694a20f83cd97da39a6d440e',
    );
    expect(armScript).not.toContain('x86_64');
  });
  it('runs the native uv build and resolves wheels for a named target CPU', async () => {
    const input: ProjectDependencyResolveInput = {
      action: 'resolve',
      manager: 'uv',
      packages: [{ name: 'six', version: '1.17.0' }],
      architecture: 'amd64',
    };
    const plan = (script: string) =>
      JSON.parse(JSON.parse(/plan=json\.loads\((".*")\)/.exec(script)![1]!));
    // An Intel Bridge's lock on an Apple-silicon server: native uv, x86_64 wheels.
    const arm = await load('arm64');
    const script = arm.resolution.projectResolutionScript(input);
    expect(plan(script)).toMatchObject({
      asset: { fileName: 'uv-0.8.22-aarch64.tar.gz' },
      uvDirectory: 'uv-aarch64-unknown-linux-gnu',
      target: { machine: 'x86_64' },
    });
    for (const fragment of [
      "'--python-platform',target_platform",
      'cpython_tags(platforms=platforms)',
      "legacy={17:'manylinux2014',12:'manylinux2010',5:'manylinux1'}",
    ])
      expect(script).toContain(fragment);
    expect(script).not.toContain('sys_tags');
    expect(
      plan(
        arm.resolution.projectResolutionScript({
          ...input,
          architecture: 'arm64',
        }),
      ),
    ).toMatchObject({ target: { machine: 'aarch64' } });
  });
  it('accepts a target CPU for uv resolutions only', async () => {
    const { ProjectDependencyResolveInputSchema } =
      await import('../project-dependency-resolution.ts');
    const base = {
      action: 'resolve',
      packages: [{ name: 'six', version: '1.17.0' }],
    };
    expect(
      ProjectDependencyResolveInputSchema.safeParse({
        ...base,
        manager: 'uv',
        architecture: 'amd64',
      }).success,
    ).toBe(true);
    for (const bad of [
      { ...base, manager: 'uv', architecture: 'x86_64' },
      { ...base, manager: 'pnpm', architecture: 'amd64' },
    ])
      expect(ProjectDependencyResolveInputSchema.safeParse(bad).success).toBe(
        false,
      );
  });
});
