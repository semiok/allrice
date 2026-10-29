import { DSH_DISTRIBUTION_CURRENT_VERSION } from './dsh-distribution.js';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
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
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-session-query-sqlite',
] as const;

const deniedHostPlugins = [
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-mcp',
  '@deepseek-ai/dsh-dynamic-plugin',
] as const;

async function readProfile(name: string) {
  return parseDocument(
    await readFile(
      resolve(import.meta.dirname, `../../dsh/${name}.cordis.yml`),
      'utf8',
    ),
    {
      customTags: [
        { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value },
      ],
    },
  ).toJS() as { id: string; name: string; config?: Record<string, unknown> }[];
}

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
      const profile = await readProfile(name);
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

  it.each(['allrice-restricted', 'allrice-technical'])(
    '%s preserves the 4096px long edge of a stored 4096x256 PNG',
    async (name) => {
      const profile = await readProfile(name);
      const attachments = profile.find(({ id }) => id === 'attachments')!;
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-dsh-image-defaults-')),
      );
      const ctx = new Context();
      try {
        const store = new LocalAttachmentStore(ctx, {
          ...LocalAttachmentStore.Config(attachments.config),
          dshHome: root,
        });
        // A valid 4096x256 monochrome PNG, below the native pixel/byte budgets.
        // The former 2048px override would downscale it to 2048x128.
        const ref = await store.saveImage({
          mediaType: 'image/png',
          data: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAEAAAAAEAAQAAAAAbcY7AAAAAlUlEQVR42u3BAQ0AAADCoPdP7ewBFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3AR4AAY/4QuAAAAAASUVORK5CYII=',
            'base64',
          ),
          name: 'wide.png',
        });
        // Native reads decode the persisted bytes and verify their dimensions
        // against the reference, so this also checks the image on disk.
        const stored = await store.readImage(ref);
        expect(stored.ref).toMatchObject({ width: 4096, height: 256 });
      } finally {
        await ctx.root.fiber.dispose();
        await rm(root, { recursive: true, force: true });
      }
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
    expect(production).not.toContain('ALLRICE_ASSISTANTS_ENABLED');
    expect(production).not.toContain('governedAssistants');
    expect(production).not.toContain('@deepseek-ai/dsh-subagent/internal');
    for (const name of ['allrice-restricted', 'allrice-technical']) {
      const profile = await readProfile(name);
      expect(
        profile.filter((p) => p.name === '@deepseek-ai/dsh-subagent'),
      ).toEqual([{ id: 'subagents', name: '@deepseek-ai/dsh-subagent' }]);
      expect(
        profile.filter(
          (p) => p.name === '@deepseek-ai/dsh-session-query-sqlite',
        ),
      ).toEqual([
        {
          id: 'native-session-query',
          name: '@deepseek-ai/dsh-session-query-sqlite',
          config: { path: ':memory:', openAt: 'never' },
        },
      ]);
      // The catalog service grants neither a backend nor model-facing tools.
      for (const plugin of profile)
        expect(plugin.name).not.toMatch(
          /^@deepseek-ai\/dsh-(subagent-|tool-subagent|user-approval)/,
        );
    }
  });
});
