'use client';

import {
  TaskSuggestionsSchema,
  employeeToolCatalog,
  workspaceCapabilityIds,
  type TaskSuggestion,
  type TaskSuggestionSlot,
} from '@allrice/contracts';
import styles from './employee-production.module.css';

export function EmployeeTaskSuggestions({
  value,
  toolNames,
  skills,
  onChange,
}: {
  value: TaskSuggestion[] | undefined;
  toolNames: string[];
  skills: { id: string; name: string }[];
  onChange: (value: TaskSuggestion[] | undefined) => void;
}) {
  const suggestions = value ?? [];
  const validation = TaskSuggestionsSchema.safeParse(suggestions);
  function edit(index: number, patch: Partial<TaskSuggestion>) {
    onChange(
      suggestions.map((suggestion, i) =>
        i === index ? { ...suggestion, ...patch } : suggestion,
      ),
    );
  }
  function editSlot(
    index: number,
    slotIndex: number,
    patch: Partial<TaskSuggestionSlot>,
  ) {
    const suggestion = suggestions[index]!;
    edit(index, {
      slots: (suggestion.slots ?? []).map((slot, i) =>
        i === slotIndex ? { ...slot, ...patch } : slot,
      ),
    });
  }
  return (
    <section className={styles.taskSuggestions} aria-label="推荐任务配置">
      <h3>推荐任务</h3>
      <p>
        点击只填写草稿。保存并发布后，所有已配发的普通员工即可使用。最多 8
        条，顺序决定常用任务。
      </p>
      {value === undefined ? (
        <p>当前沿用按实际能力匹配的默认任务；历史发布版本和运行包保持原样。</p>
      ) : !suggestions.length ? (
        <p>当前明确配置为空，发布后不展示推荐任务。</p>
      ) : null}
      {!validation.success && (
        <ul role="alert">
          {validation.error.issues.map((issue, i) => (
            <li key={i}>
              推荐任务 {Number(issue.path[0]) + 1} ·{' '}
              {issue.path.slice(1).join('.')}：{issue.message}
            </li>
          ))}
        </ul>
      )}
      {suggestions.map((suggestion, index) => (
        <details key={suggestion.id} open className={styles.taskSuggestion}>
          <summary>
            {index + 1}. {suggestion.title || '未命名任务'}
          </summary>
          <small>稳定 ID：{suggestion.id}</small>
          <div className={styles.grid}>
            <label className={styles.field}>
              标题
              <input
                value={suggestion.title}
                maxLength={60}
                onChange={(e) => edit(index, { title: e.target.value })}
              />
            </label>
            <label className={styles.field}>
              说明
              <input
                value={suggestion.description ?? ''}
                maxLength={300}
                onChange={(e) =>
                  edit(index, { description: e.target.value || undefined })
                }
              />
            </label>
            <label className={`${styles.field} ${styles.fieldWide}`}>
              草稿模板
              <textarea
                rows={3}
                value={suggestion.template}
                maxLength={8000}
                placeholder="例如：整理最近 {{days}} 天的工作。"
                onChange={(e) => edit(index, { template: e.target.value })}
              />
            </label>
          </div>
          <p>参数仅替换本模板中的 {'{{参数名}}'}，填写后成为普通可编辑文字。</p>
          {(suggestion.slots ?? []).map((slot, slotIndex) => (
            <fieldset key={slotIndex} className={styles.taskSlot}>
              <legend>参数 {slotIndex + 1}</legend>
              <div className={styles.grid}>
                <label className={styles.field}>
                  参数名
                  <input
                    value={slot.name}
                    onChange={(e) =>
                      editSlot(index, slotIndex, { name: e.target.value })
                    }
                  />
                </label>
                <label className={styles.field}>
                  显示名称
                  <input
                    value={slot.label}
                    onChange={(e) =>
                      editSlot(index, slotIndex, { label: e.target.value })
                    }
                  />
                </label>
                <label className={styles.field}>
                  默认值
                  <input
                    value={slot.defaultValue ?? ''}
                    onChange={(e) =>
                      editSlot(index, slotIndex, {
                        defaultValue: e.target.value || undefined,
                      })
                    }
                  />
                </label>
                <label className={styles.field}>
                  固定选项（每行一个，可留空）
                  <textarea
                    rows={2}
                    value={slot.options?.join('\n') ?? ''}
                    onChange={(e) =>
                      editSlot(index, slotIndex, {
                        options: e.target.value
                          ? e.target.value.split('\n')
                          : undefined,
                      })
                    }
                  />
                </label>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={slot.required === true}
                  onChange={(e) =>
                    editSlot(index, slotIndex, { required: e.target.checked })
                  }
                />
                必需参数（没有默认值时先填写表单）
              </label>
              <button
                type="button"
                onClick={() =>
                  edit(index, {
                    slots: suggestion.slots?.filter((_, i) => i !== slotIndex),
                  })
                }
              >
                移除参数 {slotIndex + 1}
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            disabled={(suggestion.slots?.length ?? 0) >= 8}
            onClick={() =>
              edit(index, {
                slots: [
                  ...(suggestion.slots ?? []),
                  {
                    name: `param${(suggestion.slots?.length ?? 0) + 1}`,
                    label: '参数',
                    required: true,
                  },
                ],
              })
            }
          >
            添加参数
          </button>
          <fieldset className={styles.taskSlot}>
            <legend>实际能力引用</legend>
            <p>
              引用只能限制推荐展示，不能添加工具或授权。先在“技能”页装配所需能力。
            </p>
            <div className={styles.taskChecks}>
              {[
                ...new Set([
                  ...toolNames,
                  ...(suggestion.requires?.toolNames ?? []),
                ]),
              ].map((name) => (
                <label key={name}>
                  <input
                    type="checkbox"
                    checked={
                      suggestion.requires?.toolNames?.includes(name) ?? false
                    }
                    onChange={(e) =>
                      edit(index, {
                        requires: {
                          ...suggestion.requires,
                          toolNames: e.target.checked
                            ? [...(suggestion.requires?.toolNames ?? []), name]
                            : suggestion.requires?.toolNames?.filter(
                                (item) => item !== name,
                              ),
                        },
                      })
                    }
                  />
                  {employeeToolCatalog.find(
                    (tool) => tool.canonicalName === name,
                  )?.label ?? name}
                  {!toolNames.includes(name) ? `（未装配：${name}）` : ''}
                </label>
              ))}
              {[
                ...new Set([
                  ...skills.map((skill) => skill.id),
                  ...(suggestion.requires?.nativeSkillIds ?? []),
                ]),
              ].map((id) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked={
                      suggestion.requires?.nativeSkillIds?.includes(id) ?? false
                    }
                    onChange={(e) =>
                      edit(index, {
                        requires: {
                          ...suggestion.requires,
                          nativeSkillIds: e.target.checked
                            ? [
                                ...(suggestion.requires?.nativeSkillIds ?? []),
                                id,
                              ]
                            : suggestion.requires?.nativeSkillIds?.filter(
                                (item) => item !== id,
                              ),
                        },
                      })
                    }
                  />
                  Skill：
                  {skills.find((skill) => skill.id === id)?.name ??
                    `未装配（${id}）`}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className={styles.taskSlot}>
            <legend>准备条件</legend>
            <div className={styles.taskChecks}>
              {(
                [
                  ['files', '资料文件'],
                  ['bridge', 'Bridge / 项目目录'],
                  ['connections', '应用账号'],
                ] as const
              ).map(([id, label]) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked={suggestion.preparation?.includes(id) ?? false}
                    onChange={(e) =>
                      edit(index, {
                        preparation: e.target.checked
                          ? [...(suggestion.preparation ?? []), id]
                          : suggestion.preparation?.filter(
                              (item) => item !== id,
                            ),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <label className={styles.field}>
              能力状态依据（可选）
              <select
                multiple
                value={suggestion.requires?.readiness ?? []}
                onChange={(e) =>
                  edit(index, {
                    requires: {
                      ...suggestion.requires,
                      readiness: [...e.currentTarget.selectedOptions].map(
                        (option) =>
                          option.value as (typeof workspaceCapabilityIds)[number],
                      ),
                    },
                  })
                }
              >
                {workspaceCapabilityIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          <div className={styles.taskActions}>
            <button
              type="button"
              disabled={index === 0}
              onClick={() => {
                const next = [...suggestions];
                [next[index - 1], next[index]] = [
                  next[index]!,
                  next[index - 1]!,
                ];
                onChange(next);
              }}
            >
              上移
            </button>
            <button
              type="button"
              disabled={index === suggestions.length - 1}
              onClick={() => {
                const next = [...suggestions];
                [next[index + 1], next[index]] = [
                  next[index]!,
                  next[index + 1]!,
                ];
                onChange(next);
              }}
            >
              下移
            </button>
            <button
              type="button"
              onClick={() =>
                onChange(suggestions.filter((_, i) => i !== index))
              }
            >
              移除任务
            </button>
          </div>
        </details>
      ))}
      <div className={styles.taskActions}>
        <button
          type="button"
          disabled={suggestions.length >= 8}
          onClick={() =>
            onChange([
              ...suggestions,
              {
                id: `task-${crypto.randomUUID()}`,
                title: '新任务',
                template: '根据我提供的内容，整理重点和待办。',
              },
            ])
          }
        >
          新增推荐任务
        </button>
        {value !== undefined && (
          <button type="button" onClick={() => onChange(undefined)}>
            恢复按能力匹配的默认任务
          </button>
        )}
      </div>
    </section>
  );
}
