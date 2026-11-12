// Isolated S1 display fixture. No production route, HTTP adapter, or installation.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  EmployeeSkillCatalogSchema,
  type EmployeeSkillCatalog,
} from '@allrice/contracts';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { setAppearance } from '../lib/theme/appearance';
import { useThemeSync } from '../components/theme/theme-controller';
import {
  EmployeeSkillsSection,
  EmployeeSkillDetails,
  type EmployeeSkill,
  type EmployeeSkillsView,
} from '../app/chatflow/employee-skills-section';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '@allrice/ui/styles.css';
import css from './employee-skills-section-page.module.css';
import { EmployeePluginPresentationFixture } from './employee-plugin-presentation';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const checksum = `sha256:${'a'.repeat(64)}`;
// a46c's explicitly synthetic visual examples; none represents a real tenant.
const platformSamples = [
  {
    slug: 'office',
    name: 'Office 文档',
    description:
      '统一读取和分析 PDF、Word、Excel、PPT、文本与图片；优先执行 DSH 原生 Office 流程，交付可下载、有版本记录的文档、表格和演示文稿。',
    version: '1.7.6',
  },
  {
    slug: 'web-research',
    name: '网页调研',
    description:
      '查询普通公开网页、新闻和最新事实，读取指定网页并提供来源。指定链接直接读取；公众号文章使用公众号调研，跨来源综合比较使用研究汇总，需要网页渲染或截图时使用浏览器调研。',
    version: '1.1.1',
  },
  {
    slug: 'browser-research',
    name: '浏览器调研',
    description:
      '读取需要 JavaScript 渲染或只读交互的公开网页，或按要求获取页面截图。普通搜索和静态页面读取优先使用网页调研；登录和网页写入操作不属于此技能。',
    version: '1.2.1',
  },
  {
    slug: 'wechat-research',
    name: '公众号调研',
    description:
      '读取指定微信公众号公开文章，或按主题、公众号名称查找文章并整理内容。已有文章链接时直接读取；需要跨来源比较和核验时使用研究汇总。',
    version: '1.1.1',
  },
  {
    slug: 'research-synthesis',
    name: '资料综合',
    description:
      '比较多个来源、核验争议信息，或综合网页与公众号资料形成附来源的结论。适用于跨来源研究；单篇摘要、简单事实查询无需启动完整调研流程。',
    version: '1.1.1',
  },
  {
    slug: 'workspace-briefing',
    name: '工作区简报',
    description:
      '检查当前获准访问的 AllRice 云端文件或 AllRice 助手本地工作区，根据文件内容和 Git 状态生成有依据的工作简报。',
    version: '1.2.1',
  },
  {
    slug: 'market-data',
    name: '行情数据',
    description:
      '查询股票、指数、ETF、汇率、加密货币和商品的结构化公开行情与历史走势，明确数据时间、币种、来源和延迟限制。',
    version: '1.0.1',
  },
  {
    slug: 'business-reconciliation',
    name: '业务对账',
    description:
      '核对用户上传的 CNY 发票与回款 CSV，说明重复、缺失和差异；修正后复算并交付保留旧版的 Excel 对账表。',
    version: '1.1.1',
  },
  {
    slug: 'operations-review',
    name: '经营复盘',
    description:
      '从经营资料核对指标、解释变化，制定有负责人、期限和验证标准的行动计划，交付可复算报告并支持数据修正后的版本续办。',
    version: '1.0.3',
  },
  {
    slug: 'scientific-analysis',
    name: '科学分析',
    description:
      '核查研究资料与数据口径，完成可复算的分析、图表和研究报告，并保留来源、方法、限制及成果版本。适用于数据研究与后续分析修改。',
    version: '1.0.2',
  },
  {
    slug: 'project-development',
    name: '项目开发',
    description:
      '使用现有保存项目、受管执行和私有预览完成小型软件开发与迭代，交付经过真实测试的版本化源码和构建成果。',
    version: '1.0.7',
  },
];
const catalogSample = EmployeeSkillCatalogSchema.parse({
  instanceId: id(7),
  canInstall: true,
  platformSkills: platformSamples.map((skill, index) => ({
    kind: 'platform',
    id: id(100 + index),
    name: skill.slug,
    displayName: skill.name,
    description: skill.description,
    version: skill.version,
    checksum,
    canUninstall: false,
  })),
  personalSkills: [
    {
      kind: 'personal',
      name: 'translation-review',
      displayName: '翻译校对',
      description: '按术语表校对中英文稿件',
      version: '0.3.0',
      installationVersion: 9,
      installationId: id(200),
      versionId: id(201),
      revision: 4,
      binding: {
        id: id(202),
        instanceId: id(7),
        workspaceId: id(4),
        enabled: true,
        epoch: 1,
        label: '流程哥',
      },
      source: {
        kind: 'attachment',
        objectId: id(203),
        fileName: 'translation-review.zip',
        originalChecksum: checksum,
        byteLength: 100,
      },
      canUninstall: true,
      definitionChecksum: checksum,
      resourceCount: 0,
    },
  ],
});

function catalogFor(mode: string): EmployeeSkillCatalog {
  const catalog = structuredClone(catalogSample);
  if (mode === 'empty') catalog.personalSkills = [];
  if (mode === 'read-only') {
    catalog.canInstall = false;
    catalog.personalSkills = catalog.personalSkills.map((skill) => ({
      ...skill,
      canUninstall: false,
    }));
  }
  if (mode === 'two-base')
    catalog.platformSkills = catalog.platformSkills.slice(0, 2);
  if (mode === 'missing-version')
    catalog.personalSkills = catalog.personalSkills.map((skill) => ({
      ...skill,
      version: null,
    }));
  if (mode === 'prefixed-version' || mode === 'author-version')
    catalog.personalSkills = catalog.personalSkills.map((skill) => ({
      ...skill,
      version: mode === 'prefixed-version' ? 'v0.3.0' : 'release-candidate',
    }));
  if (mode === 'github')
    catalog.personalSkills = catalog.personalSkills.map((skill) => ({
      ...skill,
      source: {
        kind: 'github',
        requestedUrl: 'https://github.com/example/translation-review',
        owner: 'example',
        repository: 'translation-review',
        resolvedRef: 'main',
        commitSha: 'b'.repeat(40),
        treeSha: 'c'.repeat(40),
        sourcePath: '',
        fileName: 'translation-review.zip',
        originalChecksum: checksum,
        byteLength: 100,
        candidatePath: 'SKILL.md',
        license: { status: 'unknown' },
      },
    }));
  return EmployeeSkillCatalogSchema.parse(catalog);
}

const theme =
  new URLSearchParams(location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light';
setAppearance(theme);

function App() {
  useThemeSync('/chatflow');
  const [mode, setMode] = useState('personal');
  const [phase, setPhase] = useState('ready');
  const [callbacks, setCallbacks] = useState(true);
  const [selected, setSelected] = useState<EmployeeSkill | null>(null);
  const [events, setEvents] = useState<
    Array<{ action: string; instanceId: string; installationId?: string }>
  >([]);
  const catalog = catalogFor(mode);
  const record = (action: string, skill?: EmployeeSkill) =>
    setEvents((previous) => [
      ...previous,
      {
        action,
        instanceId: catalog.instanceId,
        ...(skill?.kind === 'personal'
          ? { installationId: skill.installationId }
          : {}),
      },
    ]);
  const view: EmployeeSkillsView =
    phase === 'loading'
      ? { status: 'loading', label: '正在读取…' }
      : phase === 'error'
        ? {
            status: 'error',
            message: '个人技能暂时无法读取，请重试。',
            onRetry: () => {
              record('retry');
              setPhase('loading');
            },
          }
        : { status: 'ready', catalog };
  return (
    <main className={css.candidate}>
      <aside className={css.toolbar} aria-label="模块审阅夹具">
        <p>S1 模块候选 · a46c 合成目录 · 不读取或安装</p>
        <label>
          目录{' '}
          <select
            aria-label="夹具目录"
            value={mode}
            onChange={(event) => {
              setMode(event.target.value);
              setSelected(null);
            }}
          >
            <option value="personal">已添加样例</option>
            <option value="empty">0 项</option>
            <option value="read-only">只读能力</option>
            <option value="two-base">2 个基础技能</option>
            <option value="missing-version">未提供版本</option>
            <option value="prefixed-version">作者版本带 v</option>
            <option value="author-version">作者版本原文</option>
            <option value="github">GitHub 来源</option>
          </select>
        </label>
        <label>
          状态{' '}
          <select
            aria-label="夹具状态"
            value={phase}
            onChange={(event) => {
              setPhase(event.target.value);
              setSelected(null);
            }}
          >
            <option value="ready">已读取</option>
            <option value="loading">读取中</option>
            <option value="error">失败</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={callbacks}
            onChange={(event) => setCallbacks(event.target.checked)}
          />
          提供写操作回调
        </label>
      </aside>
      <article className={css.card}>
        <header className={css.header}>
          <h2>AI 员工详情</h2>
        </header>
        <div className={css.body}>
          <EmployeeSkillsSection
            view={view}
            onOpen={setSelected}
            onAdd={callbacks ? () => record('add') : undefined}
          />
        </div>
      </article>
      <output className={css.events} aria-label="夹具回调记录">
        {JSON.stringify(events)}
      </output>
      <Modal
        open={selected !== null}
        headless
        title={selected?.displayName ?? '技能'}
        onClose={() => setSelected(null)}
        className={css.dialog}
        backdropBlur={false}
      >
        {selected && (
          <EmployeeSkillDetails
            skill={selected}
            canInstall={catalog.canInstall}
            onBack={() => setSelected(null)}
            onUpdate={
              callbacks ? (skill) => record('update', skill) : undefined
            }
            onUninstall={
              callbacks ? (skill) => record('uninstall', skill) : undefined
            }
          />
        )}
      </Modal>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).has('plugins') ? (
    <EmployeePluginPresentationFixture />
  ) : (
    <App />
  ),
);
