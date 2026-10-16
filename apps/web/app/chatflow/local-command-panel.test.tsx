import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  sandboxExecutionBudgetSpec,
  resolveSandboxExecutionPolicy,
  type RuntimeLocalCommand,
} from '@allrice/contracts';
import { LocalCommandRuntimeScope } from './local-command-panel';

const command = {
  path: '.',
  files: [],
  network: 'none',
  limits: { timeoutMs: 30000, memoryMiB: 128, pids: 32 },
} as unknown as RuntimeLocalCommand['arguments'];
describe('local execution permission disclosure', () => {
  it('retains the actual legacy timeout and offline state', () => {
    const html = renderToStaticMarkup(
      <LocalCommandRuntimeScope command={command} />,
    );
    expect(html).toContain('时限 30 秒');
    expect(html).toContain('不联网');
    expect(html).not.toContain('累计上限');
  });
  it.each([600000, 1800000, 3600000] as const)(
    'discloses the frozen %i cap, origins and permitted input transfer',
    (maxExecutionMs) => {
      const policy = resolveSandboxExecutionPolicy([
        {
          scope: 'user',
          scopeId: '11111111-1111-4111-8111-111111111111',
          source: 'tenant_override',
          maxExecutionMs,
        },
      ]);
      const budget = sandboxExecutionBudgetSpec(
        { version: 1, kind: 'compute' },
        policy,
      );
      const html = renderToStaticMarkup(
        <LocalCommandRuntimeScope
          command={{
            ...command,
            files: [{ path: 'input.csv', sha256: 'sha256:' + 'a'.repeat(64) }],
            network: {
              mode: 'controlled_https',
              origins: ['https://pypi.org'],
            },
          }}
          executionBudget={budget}
        />,
      );
      expect(html).toContain(`累计上限 ${maxExecutionMs / 60000} 分钟`);
      expect(html).toContain('https://pypi.org');
      expect(html).toContain('本次输入文件的内容允许发送');
      expect(html).toContain('已经发送的数据无法撤回');
      expect(html).toContain('任务剩余时间不足时会提前停止');
      expect(html).not.toContain('时限 30 秒');
    },
  );
});
