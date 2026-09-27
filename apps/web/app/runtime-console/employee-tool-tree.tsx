'use client';

import {
  type employeeToolCatalog,
  employeeToolRequirements,
  resolveEmployeeSkillIds,
  resolveEmployeeToolDependencies,
  type EmployeeSkillChoice,
  type PlatformEmployeeDefinition,
} from '@allrice/contracts';

import styles from './employee-tool-tree.module.css';

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

/** Display the existing catalog graph; capability assembly remains in contracts. */
export function EmployeeToolTree({
  definition,
  skills,
  tools,
  busy,
  onSelectTool,
  onManageSkills,
}: {
  definition: PlatformEmployeeDefinition;
  skills: readonly EmployeeSkillChoice[];
  tools: readonly Tool[];
  busy: boolean;
  onSelectTool: (name: string, selected: boolean) => void;
  onManageSkills: () => void;
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
          const label = tool?.label ?? name;
          const status = repeated
            ? '已在上级包含'
            : tool?.released === false
              ? '服务已暂停'
              : effective.has(name)
                ? '自动启用'
                : '选择上级后启用';
          const content = (
            <>
              <span>{label}</span>
              <small>{status}</small>
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
                  <span className={styles.checkmark} aria-hidden="true">
                    ✓
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
        <h3>技能自带的工具</h3>
        <button type="button" onClick={onManageSkills} disabled={busy}>
          选择技能
        </button>
      </div>
      <p className={styles.hint}>
        展开技能，查看自动启用的工具；有配套工具的项目可以继续展开。
      </p>
      {selectedSkills.length ? (
        selectedSkills.map((skill) => (
          <details className={styles.skill} key={skill.id}>
            <summary>
              <strong>{employeeSkillLabel(skill)}</strong>
              <small>
                {resolveEmployeeToolDependencies(skill.requiredToolRefs).length}{' '}
                项工具 · 随技能启用
              </small>
            </summary>
            {skill.requiredToolRefs.length ? (
              dependencies(skill.requiredToolRefs)
            ) : (
              <p className={styles.hint}>此技能无需额外工具。</p>
            )}
          </details>
        ))
      ) : (
        <p className={styles.hint}>
          尚未选择技能，可以先选择技能，或在下方单独选择工具。
        </p>
      )}

      <details
        className={styles.independent}
        open={selectedSkills.length === 0 ? true : undefined}
      >
        <summary>
          <strong>单独选择工具</strong>
          <small>{explicit.size} 项已选</small>
        </summary>
        <p className={styles.hint}>
          这里勾选的工具独立启用，取消技能时也会保留。只需使用技能自带工具时，无需在这里重复勾选。
        </p>
        <div className={styles.tools}>
          {tools.map((tool) => {
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
