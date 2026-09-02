import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const migration = readFileSync(
  resolve(
    repositoryRoot,
    'packages/database/migrations/0052_foundational_dsh_skills.sql',
  ),
  'utf8',
);
const localizationMigration = readFileSync(
  resolve(
    repositoryRoot,
    'packages/database/migrations/0054_foundational_skill_chinese_descriptions.sql',
  ),
  'utf8',
);
const wechatMigration = readFileSync(
  resolve(
    repositoryRoot,
    'packages/database/migrations/0055_wechat_research_skill.sql',
  ),
  'utf8',
);
const met97Migration = readFileSync(
  resolve(
    repositoryRoot,
    'packages/database/migrations/0057_met97_p0_skills.sql',
  ),
  'utf8',
);
const met98DeliverableMigration = readFileSync(
  resolve(
    repositoryRoot,
    'packages/database/migrations/0063_met98_deliverable_versions.sql',
  ),
  'utf8',
);
const met98BrowserMigration = readFileSync(
  resolve(
    repositoryRoot,
    'packages/database/migrations/0065_met98_browser_research_skill.sql',
  ),
  'utf8',
);
const met98MemoryMigration = readFileSync(
  resolve(
    repositoryRoot,
    'packages/database/migrations/0068_met98_memory_2.sql',
  ),
  'utf8',
);

function skillSource(name: string) {
  const source = readFileSync(
    resolve(repositoryRoot, 'skills', name, 'SKILL.md'),
    'utf8',
  );
  const match = source.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]+)$/);
  if (!match) throw new Error(`${name} has invalid SKILL.md frontmatter`);
  return { frontmatter: match[1] ?? '', body: match[2] ?? '' };
}

describe('foundational DSH-native Skills', () => {
  it.each([
    {
      name: 'web-research',
      requiredTools: ['web.search'],
    },
    {
      name: 'workspace-briefing',
      requiredTools: [
        'workspace.file.list',
        'workspace.document.read',
        'local.fs.list',
        'local.fs.search',
        'local.fs.read',
        'local.git.status',
        'local.git.diff',
      ],
    },
    {
      name: 'wechat-research',
      requiredTools: ['wechat.article.search', 'wechat.article.read'],
    },
    {
      name: 'document-analysis',
      requiredTools: ['workspace.file.list', 'workspace.document.read'],
    },
    {
      name: 'market-data',
      requiredTools: ['market.quote', 'market.history'],
    },
    {
      name: 'research-synthesis',
      requiredTools: [
        'web.search',
        'web.fetch',
        'wechat.article.search',
        'wechat.article.read',
      ],
    },
    {
      name: 'structured-deliverable',
      requiredTools: ['workspace.export.create'],
    },
    {
      name: 'browser-research',
      requiredTools: ['browser.run'],
    },
    {
      name: 'governed-memory',
      requiredTools: [
        'workspace.memory.search',
        'workspace.memory.remember',
        'workspace.session.search',
      ],
    },
  ])(
    'keeps $name source and database seed aligned',
    ({ name, requiredTools }) => {
      const source = skillSource(name);
      const checksum = `sha256:${createHash('sha256').update(source.body).digest('hex')}`;

      expect(source.frontmatter).toContain(`name: ${name}`);
      expect(source.frontmatter).toMatch(/description: .+/);
      expect(source.body).not.toContain('TODO');
      const seed =
        name === 'wechat-research'
          ? wechatMigration
          : name === 'web-research'
            ? migration
            : name === 'governed-memory'
              ? met98MemoryMigration
              : name === 'browser-research'
                ? met98BrowserMigration
                : name === 'structured-deliverable'
                  ? met98DeliverableMigration
                  : met97Migration;
      expect(seed).toContain(`'${name}'`);
      expect(seed).toContain(source.body);
      expect(seed).toContain(`'${checksum}'`);
      for (const tool of requiredTools) expect(seed).toContain(`"${tool}"`);
    },
  );

  it.each([
    {
      name: 'web-research',
      summary:
        '使用获准的网页搜索研究最新公开信息，核验重要事实，并提供附有来源的综合结论。',
    },
    {
      name: 'workspace-briefing',
      summary:
        '检查当前获准访问的 AllRice 云端文件或 Rice Bridge 本地工作区，根据文件内容和 Git 状态生成有依据的工作简报。',
    },
    {
      name: 'wechat-research',
      summary:
        '搜索并读取微信公众号公开文章，核验文章信息并提供可点击的原文来源。',
    },
    {
      name: 'document-analysis',
      summary:
        '读取并分析当前工作区中获准访问的 PDF、Word、Excel、PPT、Markdown、文本和图片，提供可定位、可核验的摘要、提取、对比与问答。',
    },
    {
      name: 'market-data',
      summary:
        '查询股票、指数、ETF、汇率、加密货币和商品的结构化公开行情与历史走势，明确数据时间、币种、来源和延迟限制。',
    },
    {
      name: 'research-synthesis',
      summary:
        '围绕一个问题协调网页与公众号公开信息，进行多来源检索、时间核对、事实核验、冲突处理，并生成附来源的综合结论。',
    },
    {
      name: 'structured-deliverable',
      summary:
        '将已核验的研究、文档或工作区内容整理成结构清晰的报告、方案、清单或可下载文件，同时保留来源、边界和未决事项。',
    },
    {
      name: 'browser-research',
      summary:
        '使用隔离的云端托管浏览器读取需要 JavaScript 渲染或少量只读交互的公开网页，保留页面快照、截图和操作时间线作为可核验证据。',
    },
  ])('publishes a Chinese summary for $name', ({ name, summary }) => {
    const source = skillSource(name);

    expect(source.frontmatter).toContain('description: ');
    expect(source.frontmatter).toMatch(/description: .*[一-鿿]/);
    const localizedSeed =
      name === 'wechat-research'
        ? wechatMigration
        : name === 'browser-research'
          ? met98BrowserMigration
          : name === 'web-research'
            ? localizationMigration
            : met97Migration;
    expect(localizedSeed).toContain(`'${name}'`);
    expect(localizedSeed).toContain(`'${summary}'`);
  });

  it('clones a shared published Rice revision before activating browser research', () => {
    expect(met98BrowserMigration).toContain(
      'v_draft_revision_id is distinct from v_published_revision_id',
    );
    expect(met98BrowserMigration).toContain(
      'if v_source_revision_id = v_published_revision_id',
    );
    expect(met98BrowserMigration).toContain(
      'insert into allrice_platform_employee_revisions',
    );
    expect(met98BrowserMigration).toContain(
      'set current_draft_revision_id = v_cloned_revision_id',
    );
    expect(met98BrowserMigration).not.toContain(
      'set current_published_revision_id = v_cloned_revision_id',
    );
    expect(met98BrowserMigration).toContain(
      'previous application already supplied both capabilities',
    );
  });
});
