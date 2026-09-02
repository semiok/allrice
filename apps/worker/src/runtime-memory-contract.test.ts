import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('worker memory checkpoint contract', () => {
  it('persists a user-only candidate after the context checkpoint is saved', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, 'conversation/checkpoint-maintenance.ts'),
      'utf8',
    );
    const checkpointBlock = source;

    expect(checkpointBlock).toContain('buildCheckpointMemoryCandidate');
    expect(checkpointBlock).toContain(
      'const savedCheckpoint = await saveContextCheckpoint',
    );
    expect(checkpointBlock).toContain('createCheckpointMemoryCandidate');
    expect(checkpointBlock).toContain(
      'checkpointId: savedCheckpoint.checkpointId',
    );
    const saveIndex = checkpointBlock.indexOf(
      'const savedCheckpoint = await saveContextCheckpoint',
    );
    const candidateIndex = checkpointBlock.indexOf(
      'await createCheckpointMemoryCandidate',
      saveIndex,
    );
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(candidateIndex).toBeGreaterThan(saveIndex);
  });

  it('passes the current employee and user message provenance to native tools', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, 'jobs/employee-run.ts'),
      'utf8',
    );
    const nativeToolStart = source.indexOf('onToolCall:');
    const nativeToolBlock = source.slice(
      nativeToolStart,
      source.indexOf('threadId: runtime.threadId', nativeToolStart),
    );

    expect(nativeToolBlock).toContain(
      'employeeId: executionSnapshot.employee.id',
    );
    expect(nativeToolBlock).toContain('userMessageId,');
    expect(nativeToolBlock).toContain('userRequest: kernel.userRequest');
  });
});
