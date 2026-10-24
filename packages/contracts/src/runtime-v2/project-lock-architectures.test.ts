import { describe, expect, it } from 'vitest';
import {
  RuntimeProjectPreparationSchema,
  projectLockArchitectures,
} from './project-preparation.ts';

const uv = (...fileNames: string[]) =>
  RuntimeProjectPreparationSchema.parse({
    version: 1,
    projectId: '00000000-0000-4000-8000-000000000001',
    sourceDigest: 'sha256:' + '1'.repeat(64),
    lockChecksum: 'sha256:' + '2'.repeat(64),
    offline: false,
    manager: 'uv',
    managerVersion: '0.8.22',
    lockPath: 'requirements.lock',
    scripts: 'disabled',
    packages: fileNames.map((fileName) => ({
      name: fileName.split('-')[0],
      version: fileName.split('-')[1],
      fileName,
      url: `https://files.pythonhosted.org/packages/00/00/${fileName}`,
      sha256: 'sha256:' + '3'.repeat(64),
    })),
  });
const pure = 'six-1.17.0-py2.py3-none-any.whl',
  x86 =
    'numpy-2.2.6-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
  arm =
    'pillow-11.2.1-cp311-cp311-manylinux_2_28_aarch64.manylinux2014_aarch64.whl';

describe('project lock architectures', () => {
  it('reads where a uv lock installs from its wheel platform tags', () => {
    expect(projectLockArchitectures(uv(pure))).toEqual(['amd64', 'arm64']);
    expect(projectLockArchitectures(uv(pure, x86))).toEqual(['amd64']);
    expect(projectLockArchitectures(uv(arm, pure))).toEqual(['arm64']);
    expect(projectLockArchitectures(uv(x86, arm))).toEqual([]);
  });
  it('treats a pnpm lock as platform independent', () => {
    expect(
      projectLockArchitectures(
        RuntimeProjectPreparationSchema.parse({
          version: 1,
          projectId: '00000000-0000-4000-8000-000000000001',
          sourceDigest: 'sha256:' + '1'.repeat(64),
          lockChecksum: 'sha256:' + '2'.repeat(64),
          offline: false,
          manager: 'pnpm',
          managerVersion: '10.33.3',
          lockPath: 'pnpm-lock.yaml',
          scripts: 'disabled',
          packages: [],
        }),
      ),
    ).toEqual(['amd64', 'arm64']);
  });
});
