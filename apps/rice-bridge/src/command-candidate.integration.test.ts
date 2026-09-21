import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  candidateCommand,
  change,
  checksum,
} from '../test/command-candidate.fixture.js';
import { LocalCommandRunner } from './local-command-runner.js';

const suite = process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET
  ? describe
  : describe.skip;
suite(
  'MET-144 candidate → real isolated VM execution → correction (no host writes)',
  () => {
    it('fails v1, passes corrected v2, recovers exactly v2, rejects a mismatched command on recovery', async () => {
      const root = await mkdtemp(join(tmpdir(), 'allrice-candidate-vm-'));
      const before = 'throw Error("old source");';
      const runner = new LocalCommandRunner({
        socketPath: process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET!,
        imageDigest: candidateCommand([change('test.mjs', before, 'x')])
          .arguments.imageDigest,
      });
      const containers: { attemptId: string; id: string }[] = [];
      try {
        await writeFile(join(root, 'test.mjs'), before);
        await writeFile(join(root, 'old.txt'), 'delete in copy');
        const base = [
          { path: 'test.mjs', sha256: checksum(before) },
          { path: 'old.txt', sha256: checksum('delete in copy') },
        ];
        for (const valid of [false, true]) {
          const command = candidateCommand(
            [
              change(
                'test.mjs',
                before,
                `import { readFileSync, existsSync } from 'node:fs'; if(existsSync('old.txt')) throw Error('deletion not staged'); if(readFileSync('added.txt','utf8')!=='new') throw Error('addition missing'); ${valid ? 'console.log("candidate v2 passed");' : 'throw Error("candidate v1 failed");'}`,
              ),
              change('old.txt', 'delete in copy', null),
              change('added.txt', null, 'new'),
            ],
            base,
          );
          const attemptId = randomUUID();
          const result = await runner.execute(root, command, { attemptId });
          containers.push({ attemptId, id: result.containerId });
          expect(result.exitCode === 0).toBe(valid);
          expect(result.reason).toBe('exited');
          expect(result.candidate).toMatchObject({
            artifactId: command.arguments.candidate!.artifactId,
            checksum: command.arguments.candidate!.checksum,
          });
          expect(result.stdout + result.stderr).toContain(
            valid ? 'candidate v2 passed' : 'candidate v1 failed',
          );
          const recovered = await runner.recover(attemptId, command);
          expect(recovered?.candidate).toEqual(result.candidate);
          expect(recovered?.exitCode).toBe(result.exitCode);
          await expect(
            runner.recover(attemptId, {
              ...command,
              arguments: { ...command.arguments, args: ['not-tested.mjs'] },
            }),
          ).rejects.toMatchObject({ code: 'CANDIDATE_EVIDENCE_MISSING' });
        }
        expect(await readFile(join(root, 'test.mjs'), 'utf8')).toBe(before);
        expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe(
          'delete in copy',
        );
        await expect(readFile(join(root, 'added.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        for (const container of containers)
          await runner.cleanup(container.attemptId, container.id);
        await rm(root, { recursive: true, force: true });
      }
    }, 60000);
  },
);
