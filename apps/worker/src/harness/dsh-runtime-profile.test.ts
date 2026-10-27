import { DSH_DISTRIBUTION_CURRENT_VERSION } from './dsh-distribution.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import LocalAttachmentStore, {
  DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
} from '@deepseek-ai/dsh-attachment-local';
import { Config as RepeatToolReminderConfig } from '@deepseek-ai/dsh-repeat-tool-reminder';
import { parseDocument } from 'yaml';

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
      expect(workerPackage.dependencies[plugin]).toBe(
        DSH_DISTRIBUTION_CURRENT_VERSION,
      );
    }
    for (const plugin of deniedHostPlugins) {
      expect(profile).not.toContain(`name: '${plugin}'`);
    }

    expect(profile).toContain('maxRetries: 2');
    expect(profile).toContain('thresholdChars: 8192');
  });

  it.each(['allrice-restricted', 'allrice-technical'])(
    '%s uses native image and repeat defaults and the standard Todo policy',
    async (name) => {
      const profile = parseDocument(
        await readFile(
          resolve(import.meta.dirname, `../../dsh/${name}.cordis.yml`),
          'utf8',
        ),
        {
          customTags: [
            { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value },
          ],
        },
      ).toJS() as { id: string; config?: Record<string, unknown> }[];
      const attachments = profile.find(({ id }) => id === 'attachments')!;
      expect(attachments.config).not.toHaveProperty(
        'normalizedImageMaxDimension',
      );
      expect(
        LocalAttachmentStore.Config(attachments.config)
          .normalizedImageMaxDimension,
      ).toBe(DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION);
      expect(DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION).toBe(8192);

      const reminder = profile.find(({ id }) => id === 'repeat-tool-reminder')!;
      expect(reminder.config).not.toHaveProperty('exclude');
      expect(RepeatToolReminderConfig(reminder.config).exclude).toEqual([]);

      const todo = profile.find(({ id }) => id === 'tool-todo');
      // The technical profile has no Todo tool; do not add one to restore defaults.
      if (name === 'allrice-restricted')
        expect(todo?.config?.allowParallelInProgress).toBe(true);
      else expect(todo).toBeUndefined();
    },
  );

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
      expect(pkg.dependencies[name]).toBe(DSH_DISTRIBUTION_CURRENT_VERSION);
      expect(pkg.devDependencies[name]).toBeUndefined();
    }
    const production = await readFile(
      resolve(
        import.meta.dirname,
        '../../dsh/allrice-jsonrpc-implementation.mjs',
      ),
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
