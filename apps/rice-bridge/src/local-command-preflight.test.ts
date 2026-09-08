import { afterEach, describe, expect, it, vi } from 'vitest';
import { localCommandToolchainImageV1 } from '@allrice/contracts';
import { LocalCommandRunner } from './local-command-runner.js';

const nativeArchitecture = process.arch === 'arm64' ? 'arm64' : 'amd64';
describe.skipIf(process.platform !== 'darwin')(
  'native runner preflight',
  () => {
    afterEach(() => vi.restoreAllMocks());
    it.each([
      'ok',
      'foreign_daemon',
      'foreign_image',
      'changed_image',
      'missing_cgroups',
      'missing_seccomp',
    ])('validates native isolation: %s', async (scenario) => {
      const runner = new LocalCommandRunner({
        socketPath: '/synthetic/docker.sock',
        imageDigest: localCommandToolchainImageV1,
      });
      vi.spyOn(runner.api, 'verifySocket').mockResolvedValue();
      vi.spyOn(runner.api, 'json').mockImplementation(async (_method, path) =>
        path === '/info'
          ? {
              OSType: 'linux',
              Architecture:
                scenario === 'foreign_daemon' ? 'ppc64le' : nativeArchitecture,
              CgroupVersion: scenario === 'missing_cgroups' ? '1' : '2',
              MemoryLimit: true,
              SwapLimit: true,
              PidsLimit: true,
              CpuCfsQuota: true,
              SecurityOptions:
                scenario === 'missing_seccomp'
                  ? []
                  : ['name=seccomp,profile=builtin'],
            }
          : {
              Id:
                scenario === 'changed_image'
                  ? `sha256:${'f'.repeat(64)}`
                  : localCommandToolchainImageV1,
              Os: 'linux',
              Architecture:
                scenario === 'foreign_image' ? 'ppc64le' : nativeArchitecture,
            },
      );
      if (scenario === 'ok')
        expect((await runner.preflight()).architecture).toBe(
          nativeArchitecture,
        );
      else await expect(runner.preflight()).rejects.toThrow();
      expect(runner.api.json).not.toHaveBeenCalledWith(
        'POST',
        expect.anything(),
        expect.anything(),
      );
    });
  },
);
