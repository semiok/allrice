import { describe, expect, it } from 'vitest';

import {
  dshRuntimeCoreComponents,
  runtimeCapabilityCatalog,
} from './runtime-capability-catalog';

describe('runtime capability source catalog', () => {
  it('keeps runtime plugins, AllRice capabilities and blocked items disjoint', () => {
    expect(runtimeCapabilityCatalog.map((group) => group.source)).toEqual([
      'dsh-plugin',
      'allrice',
      'blocked',
    ]);

    const ids = [
      ...dshRuntimeCoreComponents.map((item) => item.id),
      ...runtimeCapabilityCatalog.flatMap((group) =>
        group.items.map((item) => item.id),
      ),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('records the complete approved DSH enhancement batch', () => {
    const plugins = runtimeCapabilityCatalog.find(
      (group) => group.source === 'dsh-plugin',
    );
    expect(plugins?.items.map((item) => item.packageName)).toEqual([
      '@deepseek-ai/dsh-llm-retry',
      '@deepseek-ai/dsh-tool-call-timeout-policy',
      '@deepseek-ai/dsh-compaction-tool-result-pruner',
      '@deepseek-ai/dsh-repeat-tool-reminder',
      '@deepseek-ai/dsh-user-questions',
      '@deepseek-ai/dsh-tool-ask-user',
      '@deepseek-ai/dsh-tool-todo',
    ]);
  });

  it('describes the always-loaded DSH runtime skeleton separately', () => {
    expect(dshRuntimeCoreComponents.map((item) => item.id)).toEqual([
      'credentials',
      'authorization',
      'attachments',
      'provider-router',
      'agent-loop',
      'skill-registry',
      'skill-tool',
      'session-persistence',
      'session-checkpoints',
      'session-projection',
      'token-meter',
      'compaction-basic',
    ]);
    expect(
      dshRuntimeCoreComponents.find((item) => item.id === 'skill-registry')
        ?.detail,
    ).toContain('不会自动扫描 DSH Home');
  });

  it('does not present unrestricted host tools as approved plugins', () => {
    const approvedPackages = runtimeCapabilityCatalog
      .find((group) => group.source === 'dsh-plugin')
      ?.items.flatMap((item) => item.packageName ?? []);
    expect(approvedPackages?.join(' ')).not.toMatch(
      /tool-bash|tool-fs|subagent|dynamic-plugin|mcp/i,
    );
  });
});
