import { testImage } from '../test/toolchain.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import {
  RuntimeChangesetSchema,
  RuntimeLocalCommandSchema,
} from '@allrice/contracts';
import { executeChangeset } from './changeset-executor.js';
import { LocalCommandRunner } from './local-command-runner.js';
const suite = process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET
  ? describe
  : describe.skip;
const side = (text: string) => ({
  text,
  checksum: `sha256:${createHash('sha256').update(text).digest('hex')}`,
});
suite('P08/P05 real supported project modification → VM test → repair', () => {
  it('tests exact copies, reports failure, applies a newly reviewed revision and passes without host-side execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-p08-vm-project-'));
    const runner = new LocalCommandRunner({
      socketPath: process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET!,
      imageDigest: process.env.ALLRICE_LOCAL_DOCKER_TEST_IMAGE ?? testImage,
    });
    const attemptIds: { attemptId: string; containerId: string }[] = [];
    const bad = side('throw new Error("synthetic failing test");'),
      good = side('console.log("P08 repaired project passed");');
    async function apply(
      before: ReturnType<typeof side> | null,
      after: ReturnType<typeof side>,
    ) {
      const payload = RuntimeChangesetSchema.parse({
        capability: 'local.fs.changeset',
        arguments: {
          path: '.',
          artifactId: randomUUID(),
          checksum: side(JSON.stringify({ before, after })).checksum,
          direction: 'apply',
          files: [{ path: 'test.mjs', before, after }],
        },
      });
      // Database-backed exact approvals are tested separately with the real Worker/HTTP client.
      const result = await executeChangeset(root, payload, {
        authorize: async () => true,
        checkpoint: async () => {},
      });
      expect(result.files[0]?.status).toBe('applied');
    }
    async function test(source: ReturnType<typeof side>) {
      const attemptId = randomUUID();
      const payload = RuntimeLocalCommandSchema.parse({
        capability: 'local.process.execute',
        arguments: {
          executable: '/usr/local/bin/node',
          args: ['test.mjs'],
          path: '.',
          files: [{ path: 'test.mjs', sha256: source.checksum }],
          imageDigest: runner.config.imageDigest,
          isolation: 'local-vm-container-v1',
          network: 'none',
          limits: {
            timeoutMs: 10000,
            outputBytes: 8192,
            memoryMiB: 128,
            cpuMillis: 500,
            pids: 32,
          },
        },
      });
      const result = await runner.execute(root, payload, { attemptId });
      attemptIds.push({ attemptId, containerId: result.containerId });
      expect(result.stopped).toBe(true);
      expect(result.sourceDirectoryModified).toBe(false);
      expect(await readFile(join(root, 'test.mjs'), 'utf8')).toBe(source.text);
      return result;
    }
    try {
      await apply(null, bad);
      expect((await test(bad)).exitCode).not.toBe(0);
      await apply(bad, good);
      expect((await test(good)).exitCode).toBe(0);
    } finally {
      for (const item of attemptIds)
        await runner.cleanup(item.attemptId, item.containerId);
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
