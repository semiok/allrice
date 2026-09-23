import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const approvedPlugins = [
  '@deepseek-ai/dsh-llm-retry',
  '@deepseek-ai/dsh-tool-call-timeout-policy',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-repeat-tool-reminder',
  '@deepseek-ai/dsh-user-questions',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-tool-todo',
] as const;

const deniedHostPlugins = [
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-mcp',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-dynamic-plugin',
] as const;

describe('AllRice restricted DSH profile', () => {
  it('pins the approved MET-91 first batch without adding host capabilities', async () => {
    const profile = await readFile(
      resolve(import.meta.dirname, '../../dsh/allrice-restricted.cordis.yml'),
      'utf8',
    );
    const workerPackage = JSON.parse(
      await readFile(
        resolve(import.meta.dirname, '../../package.json'),
        'utf8',
      ),
    ) as { dependencies: Record<string, string> };

    for (const plugin of approvedPlugins) {
      expect(profile).toContain(`name: '${plugin}'`);
      expect(workerPackage.dependencies[plugin]).toBe('0.1.5-rc.3');
    }
    for (const plugin of deniedHostPlugins) {
      expect(profile).not.toContain(`name: '${plugin}'`);
    }

    expect(profile).toContain('maxRetries: 2');
    expect(profile).toContain('exclude: [todo_write]');
    expect(profile).toContain('allowParallelInProgress: false');
    expect(profile).toContain('thresholdChars: 8192');
  });

  it('pins governed P25 services while keeping native delegation absent from the default profile', async () => {
    const pkg = JSON.parse(
      await readFile(
        resolve(import.meta.dirname, '../../package.json'),
        'utf8',
      ),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const name of [
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-subagent-spawn-in-process',
      '@deepseek-ai/dsh-user-approval',
    ]) {
      expect(pkg.dependencies[name]).toBe('0.1.5-rc.3');
      expect(pkg.devDependencies[name]).toBeUndefined();
    }
    const production = await readFile(
      resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
      'utf8',
    );
    expect(production).not.toContain('p24_proposal');
    expect(production).not.toContain('poc.cordis.yml');
    expect(production).not.toContain('startContinuable');
    expect(production).toContain(
      "if (process.env.ALLRICE_ASSISTANTS_ENABLED === '1')",
    );
    expect(production).toContain("policy: 'never'");
    const profile = await readFile(
      resolve(import.meta.dirname, '../../dsh/allrice-restricted.cordis.yml'),
      'utf8',
    );
    expect(profile).not.toContain('dsh-subagent');
    expect(profile).not.toContain('dsh-user-approval');
  });
});
