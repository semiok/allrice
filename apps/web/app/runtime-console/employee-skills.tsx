'use client';

import {
  type employeeToolCatalog,
  employeeToolRequirements,
  employeeToolDependencySources,
  resolveEmployeeSkillIds,
  resolveEmployeeToolDependencies,
  type EmployeeSkillChoice,
  type PlatformEmployeeDefinition,
} from '@allrice/contracts';

import styles from './employee-skills.module.css';

export function employeeSkillLabel(skill: EmployeeSkillChoice) {
  const labels: Record<string, string> = {
    'development-cooperation': '开发协作',
    'business-reconciliation': '业务对账',
    'browser-research': '浏览器调研',
    'governed-memory': '工作记忆',
    'market-data': '行情查询',
    office: 'Office 文档处理',
    'research-synthesis': '研究汇总',
    'web-research': '网页调研',
    'wechat-research': '公众号调研',
    'workflow-automation': '自动化任务',
    'workspace-briefing': '工作区资料整理',
    'document-analysis': '文档阅读',
    'structured-deliverable': '报告交付',
  };
  return labels[skill.id] ?? labels[skill.name ?? ''] ?? skill.name ?? skill.id;
}

type Tool = (typeof employeeToolCatalog)[number] & { released: boolean };
type Skill = EmployeeSkillChoice & {
  description: string;
  enabled: boolean;
  reviewStatus: 'draft' | 'reviewed' | 'rejected';
};

const basicTools = [
  {
    name: 'assistant.delegate',
    label: '调用辅助助手',
    description: '把子任务交给辅助助手处理，再汇总结果。',
  },
  {
    name: 'web.search',
    label: '联网搜索',
    description: '搜索公开网页，获取资料。',
  },
  {
    name: 'workspace.export.create',
    label: '文件交付',
    description: '保存并交付可预览、下载的文件。',
  },
];

function toolLabel(tool: Tool | undefined, name: string) {
  return (
    (
      { 'image.generate': '生成图片', 'image.edit': '编辑图片' } as Record<
        string,
        string
      >
    )[name] ??
    tool?.label ??
    name
  );
}

/** Display the existing catalog graph; capability assembly remains in contracts. */
export function EmployeeSkills({
  definition,
  skills,
  tools,
  busy,
  onSelectTool,
  onSelectSkills,
  onInspectSkill,
}: {
  definition: PlatformEmployeeDefinition;
  skills: readonly Skill[];
  tools: readonly Tool[];
  busy: boolean;
  onSelectTool: (name: string, selected: boolean) => void;
  onSelectSkills: (ids: string[]) => void;
  onInspectSkill: (id: string) => void;
}) {
  const selectedIds = new Set(
    resolveEmployeeSkillIds(definition.capabilities.nativeSkillIds, skills),
  );
  const selectedSkills = skills.filter((skill) => selectedIds.has(skill.id));
  const explicit = new Set(
    definition.capabilities.explicitToolNames ??
      definition.capabilities.toolNames,
  );
  const effective = new Set(definition.capabilities.toolNames);
  const skillTools = new Set(
    resolveEmployeeToolDependencies(
      selectedSkills.flatMap((skill) => [...skill.requiredToolRefs]),
    ),
  );
  const byName = new Map<string, Tool>(tools.map((t) => [t.canonicalName, t]));
  const sources = employeeToolDependencySources(
    definition,
    skills.map((skill) => ({ ...skill, name: employeeSkillLabel(skill) })),
  );
  // Images follow the platform model configuration, not an employee-level switch.
  const independentTools = tools.filter(
    (tool) => !tool.canonicalName.startsWith('image.'),
  );
  const independentCount = independentTools.filter((tool) =>
    explicit.has(tool.canonicalName),
  ).length;

  function children(name: string) {
    const rule = employeeToolRequirements(name);
    return [
      ...new Set([
        ...(rule.requiredTools ?? []),
        ...(rule.workflowTools ?? []),
      ]),
    ];
  }

  function dependencies(
    names: readonly string[],
    ancestors: readonly string[] = [],
  ) {
    return (
      <ul className={styles.dependencies}>
        {[...new Set(names)].map((name) => {
          const tool = byName.get(name);
          const repeated = ancestors.includes(name);
          const nested = repeated ? [] : children(name);
          const label = toolLabel(tool, name);
          const status = repeated
            ? '已在上级包含'
            : tool?.released === false
              ? '服务已暂停'
              : effective.has(name)
                ? '已配置'
                : '选择技能或上级工具后自动配置';
          const content = (
            <>
              <span>{label}</span>
              <small>{status}</small>
              {sources[name]?.length ? (
                <small className={styles.sources}>
                  用于：{[...new Set(sources[name])].join('、')}
                </small>
              ) : null}
            </>
          );
          return (
            <li key={name}>
              {nested.length ? (
                <details>
                  <summary>{content}</summary>
                  {dependencies(nested, [...ancestors, name])}
                </details>
              ) : (
                <div className={styles.leaf}>
                  <span
                    className={styles.checkmark}
                    data-configured={effective.has(name)}
                    aria-hidden="true"
                  >
                    {effective.has(name) ? '✓' : '·'}
                  </span>
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className={styles.tree}>
      <div className={styles.heading}>
        <h3>工作技能</h3>
        <span className={styles.hint}>已选择 {selectedSkills.length} 项</span>
      </div>
      <p className={styles.hint}>
        选择技能，所需工具会自动配置。保存并发布后生效。
      </p>
      <div className={styles.skills}>
        {skills.map((skill) => {
          const selected = selectedIds.has(skill.id);
          const label = employeeSkillLabel(skill);
          const available = skill.enabled && skill.reviewStatus === 'reviewed';
          const required = resolveEmployeeToolDependencies(
            skill.requiredToolRefs,
          );
          const paused = required.filter(
            (name) => byName.get(name)?.released === false,
          );
          return (
            <section
              className={styles.skill}
              key={skill.id}
              aria-label={`技能：${label}`}
              data-selected={selected}
            >
              <div className={styles.skillHeader}>
                <label className={styles.choice}>
                  <input
                    type="checkbox"
                    aria-label={label}
                    checked={selected}
                    disabled={busy || (!selected && !available)}
                    onChange={(event) =>
                      onSelectSkills(
                        event.target.checked
                          ? [...selectedIds, skill.id]
                          : [...selectedIds].filter((id) => id !== skill.id),
                      )
                    }
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{skill.description}</small>
                  </span>
                </label>
                <span className={styles.badge} data-selected={selected}>
                  {!available ? '暂不可添加' : selected ? '已选择' : '未选择'}
                </span>
              </div>
              <div className={styles.skillBody}>
                {required.length ? (
                  <details>
                    <summary>
                      所需工具 · {required.length} 项
                      <small>
                        {selected ? '已自动配置' : '随技能自动配置'}
                      </small>
                    </summary>
                    {dependencies(skill.requiredToolRefs)}
                  </details>
                ) : (
                  <p className={styles.hint}>无需额外工具</p>
                )}
                {selected && paused.length > 0 ? (
                  <p className={styles.warning}>
                    部分工具服务已暂停：
                    {paused
                      .map((name) => toolLabel(byName.get(name), name))
                      .join('、')}
                    。配置会保留，服务恢复后可用。
                  </p>
                ) : null}
                {!available ? (
                  <p className={styles.warning}>
                    {skill.reviewStatus !== 'reviewed'
                      ? '此技能尚未通过审核。'
                      : '此技能已暂停。'}
                    {selected ? '可取消选择；保存时会检查当前配置。' : ''}
                  </p>
                ) : null}
                {selected &&
                required.some(
                  (name) => byName.get(name)?.environment === 'device',
                ) ? (
                  <p className={styles.hint}>
                    使用时需连接电脑并选择项目目录，可在设置 → 我的电脑中配置。
                  </p>
                ) : null}
                <button
                  className={styles.textButton}
                  type="button"
                  aria-label={`查看 ${label} 内容`}
                  disabled={busy}
                  onClick={() => onInspectSkill(skill.id)}
                >
                  查看说明
                </button>
              </div>
            </section>
          );
        })}
      </div>
      {!skills.length ? (
        <p className={styles.hint}>暂无可选技能，可以在下方添加基础工具。</p>
      ) : null}

      <section className={styles.basics} aria-label="基础能力">
        <h3>基础能力</h3>
        <p className={styles.hint}>
          这些工具可以独立使用，也可以由技能自动配置。
        </p>
        <div className={styles.basicGrid}>
          {basicTools.map(({ name, label, description }) => (
            <div className={styles.basic} key={name}>
              <div>
                <strong>{label}</strong>
                <span className={styles.badge}>
                  {effective.has(name)
                    ? byName.get(name)?.released === false
                      ? '服务已暂停'
                      : '已配置'
                    : '未配置'}
                </span>
              </div>
              <p className={styles.hint}>{description}</p>
              {effective.has(name) ? (
                <p className={styles.hint}>
                  {[
                    ...(explicit.has(name) ? ['单独添加'] : []),
                    ...(sources[name] ?? []),
                  ].join(' · ')}
                </p>
              ) : null}
            </div>
          ))}
          <div className={styles.basic}>
            <div>
              <strong>图片生成与编辑</strong>
              <span className={styles.badge}>平台统一配置</span>
            </div>
            <p className={styles.hint}>
              跟随平台图片设置，员工需具备文件交付能力。
            </p>
            <a href="/runtime-console?view=governance">查看平台图片配置</a>
          </div>
        </div>
      </section>

      <details className={styles.independent}>
        <summary>
          <strong>单独添加工具</strong>
          <small>{independentCount} 项已选</small>
        </summary>
        <p className={styles.hint}>
          这里勾选的工具独立启用，取消技能时也会保留。只需使用技能自带工具时，无需在这里重复勾选。
        </p>
        <div className={styles.tools}>
          {independentTools.map((tool) => {
            const name = tool.canonicalName;
            const nested = children(name);
            return (
              <div className={styles.tool} key={name}>
                <label className={styles.choice}>
                  <input
                    type="checkbox"
                    aria-label={tool.label}
                    checked={explicit.has(name)}
                    disabled={busy}
                    onChange={(event) =>
                      onSelectTool(name, event.target.checked)
                    }
                  />
                  <span>
                    <strong>{tool.label}</strong>
                    <small>
                      {tool.released
                        ? '可用 · 发布后生效'
                        : '服务已暂停，暂不可执行'}
                      {skillTools.has(name)
                        ? ' · 技能中也已包含'
                        : effective.has(name) && !explicit.has(name)
                          ? ' · 其他工具已自动启用'
                          : ''}
                    </small>
                    {sources[name]?.length ? (
                      <small>
                        用于：{[...new Set(sources[name])].join('、')}
                      </small>
                    ) : null}
                  </span>
                </label>
                {nested.length > 0 ? (
                  <details className={styles.bundle}>
                    <summary>
                      配套工具 ·{' '}
                      {resolveEmployeeToolDependencies([name]).length - 1} 项
                    </summary>
                    {dependencies(nested, [name])}
                  </details>
                ) : null}
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}
