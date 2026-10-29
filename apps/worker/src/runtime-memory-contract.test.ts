import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('worker explicit memory provenance', () => {
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
