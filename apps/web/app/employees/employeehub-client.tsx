'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AppSidebar } from '../components/app-sidebar';
import { useAppShell } from '../components/app-shell';

type Style = 'concise' | 'structured' | 'exploratory';
type Language = 'zh-CN' | 'en-US';
type Proactive = 'suggest' | 'ask' | 'disabled';
type Approval = 'confirm_side_effects' | 'confirm_external' | 'autonomous';

interface Profile {
  role: string;
  mission: string;
  communicationStyle: Style;
  outputLanguage: Language;
  proactivePolicy: Proactive;
  approvalPolicy: Approval;
}
interface Version {
  id: string;
  version: number;
  manifest: {
    name: string;
    description: string;
    skillVersionIds: string[];
    partnerProfile: Profile;
  };
}
interface Assignment {
  id: string;
  employeeId: string;
  employeeKey: string;
  isDefault: boolean;
  memoryCount: number;
  currentVersion: Version;
}
interface Skill {
  skillVersionId: string;
  name: string;
  version: string;
  enabled: boolean;
}
interface Hub {
  organizationId: string;
  workspaceId: string;
  assignments: Assignment[];
  availableSkills: Skill[];
}
interface Memory {
  id: string;
  content: string;
  createdAt: string;
}

const defaultProfile: Profile = {
  role: '通用工作伙伴',
  mission: '理解目标、推进任务，并交付可继续协作的结果。',
  communicationStyle: 'structured',
  outputLanguage: 'zh-CN',
  proactivePolicy: 'suggest',
  approvalPolicy: 'confirm_side_effects',
};

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    T | { error?: { message?: string } } | null;
  if (!response.ok)
    throw new Error(
      (body as { error?: { message?: string } } | null)?.error?.message ??
        `请求失败（${response.status}）`,
    );
  return body as T;
}

export function EmployeeHubClient({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const appShell = useAppShell();
  const [hub, setHub] = useState<Hub | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [profile, setProfile] = useState(defaultProfile);
  const [skills, setSkills] = useState<string[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selected = useMemo(
    () => hub?.assignments.find((item) => item.id === selectedId),
    [hub, selectedId],
  );
  const headers = useMemo(
    () => ({
      'content-type': 'application/json',
      'x-allrice-organization-id': hub?.organizationId ?? '',
      'x-allrice-workspace-id': hub?.workspaceId ?? '',
    }),
    [hub],
  );

  const load = useCallback(async () => {
    const result = await readJson<{ employeeHub: Hub }>(
      await fetch('/api/v1/employees', { cache: 'no-store' }),
    );
    setHub(result.employeeHub);
    setSelectedId((current) =>
      result.employeeHub.assignments.some((item) => item.id === current)
        ? current
        : (result.employeeHub.assignments[0]?.id ?? ''),
    );
  }, []);

  const loadMemories = useCallback(
    async (assignment: Assignment) => {
      if (!hub) return;
      const result = await readJson<{ memories: Memory[] }>(
        await fetch(
          `/api/v1/memories?workspaceId=${hub.workspaceId}&employeeId=${assignment.employeeId}`,
          { cache: 'no-store', headers },
        ),
      );
      setMemories(result.memories);
    },
    [headers, hub],
  );

  useEffect(() => {
    load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : '加载失败'),
    );
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    setProfile(selected.currentVersion.manifest.partnerProfile);
    setSkills(selected.currentVersion.manifest.skillVersionIds);
    loadMemories(selected).catch((cause) =>
      setError(cause instanceof Error ? cause.message : '记忆加载失败'),
    );
  }, [loadMemories, selected]);

  async function createEmployee(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hub || !createName.trim() || !createDescription.trim()) return;
    setBusy(true);
    try {
      const result = await readJson<{ employee: Assignment }>(
        await fetch('/api/v1/employees', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            workspaceId: hub.workspaceId,
            name: createName.trim(),
            description: createDescription.trim(),
            partnerProfile: { ...defaultProfile, role: createName.trim() },
            skillVersionIds: [],
          }),
        }),
      );
      await load();
      setSelectedId(result.employee.id);
      setCreateOpen(false);
      setCreateName('');
      setCreateDescription('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveEmployee() {
    if (!hub || !selected) return;
    setBusy(true);
    try {
      await readJson(
        await fetch('/api/v1/employees', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            workspaceId: hub.workspaceId,
            employeeId: selected.employeeId,
            skillVersionIds: skills,
            partnerProfile: profile,
          }),
        }),
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveMemory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hub || !selected || !memoryDraft.trim()) return;
    setBusy(true);
    try {
      const result = await readJson<{ memory: Memory }>(
        await fetch('/api/v1/memories', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            workspaceId: hub.workspaceId,
            employeeId: selected.employeeId,
            content: memoryDraft.trim(),
            visibility: 'private',
            sourceType: 'user',
            sourceId: null,
          }),
        }),
      );
      setMemories((current) => [result.memory, ...current]);
      setMemoryDraft('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '记忆保存失败');
    } finally {
      setBusy(false);
    }
  }

  if (!hub)
    return (
      <main className="workspace-loading">{error || '正在加载 AI员工…'}</main>
    );

  return (
    <main className={embedded ? 'employee-panel-only' : 'app-page-shell'}>
      {!embedded ? (
        <AppSidebar
          active="employees"
          action={
            <Link className="new-chat" href="/workspace">
              ＋ 新建任务
            </Link>
          }
          className="app-page-sidebar"
          footer={
            <div className="app-sidebar-footer">
              <Link href="/skillhub">管理 AI员工技能</Link>
            </div>
          }
        />
      ) : null}
      <section className={embedded ? undefined : 'app-page-content'}>
        <div className="skillhub-shell employeehub-shell independent-employee-shell">
          <header className="skillhub-header">
            <div>
              <p className="eyebrow">ALLRICE · AI EMPLOYEES</p>
              <h1>AI员工</h1>
              <p className="lede">
                创建独立工作伙伴，为它配置 Skill，并在持续对话中积累专属上下文。
              </p>
            </div>
            <div className="employee-header-actions">
              <button
                className="primary-action"
                onClick={() => setCreateOpen(true)}
              >
                ＋ 创建 AI员工
              </button>
              {appShell ? (
                <button
                  type="button"
                  onClick={() => appShell.navigate('workspace')}
                >
                  返回工作台
                </button>
              ) : (
                <Link href="/workspace">返回工作台</Link>
              )}
            </div>
          </header>

          <section className="employee-directory">
            <div className="partner-section-heading">
              <div>
                <p className="eyebrow">你的工作伙伴</p>
                <h2>选择一个员工进行配置</h2>
              </div>
              <span>{hub.assignments.length} 位员工</span>
            </div>
            <div className="employee-directory-grid">
              {hub.assignments.map((assignment) => (
                <button
                  className={
                    assignment.id === selectedId
                      ? 'employee-directory-card employee-directory-card-active'
                      : 'employee-directory-card'
                  }
                  key={assignment.id}
                  onClick={() => setSelectedId(assignment.id)}
                  type="button"
                >
                  <span className="employee-directory-avatar">✦</span>
                  <span>
                    <strong>{assignment.currentVersion.manifest.name}</strong>
                    <small>
                      {assignment.currentVersion.manifest.partnerProfile.role}
                    </small>
                  </span>
                  {assignment.isDefault ? (
                    <em>默认</em>
                  ) : assignment.employeeKey.startsWith('builtin-') ? (
                    <em>内置</em>
                  ) : null}
                </button>
              ))}
            </div>
          </section>

          {createOpen ? (
            <section className="employee-create-panel">
              <div className="partner-section-heading">
                <div>
                  <p className="eyebrow">创建独立员工</p>
                  <h2>让它负责一类长期工作</h2>
                </div>
                <button onClick={() => setCreateOpen(false)}>取消</button>
              </div>
              <form className="employee-form" onSubmit={createEmployee}>
                <label>
                  员工名称
                  <input
                    required
                    maxLength={120}
                    placeholder="例如：电商数据分析师"
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                  />
                </label>
                <label>
                  员工职责
                  <textarea
                    required
                    maxLength={1000}
                    placeholder="例如：负责分析店铺经营数据，发现问题并给出可执行建议。"
                    value={createDescription}
                    onChange={(event) =>
                      setCreateDescription(event.target.value)
                    }
                  />
                </label>
                <button
                  className="primary-action"
                  disabled={busy}
                  type="submit"
                >
                  {busy ? '创建中…' : '创建员工'}
                </button>
              </form>
            </section>
          ) : null}

          {selected ? (
            <section className="employee-detail-panel">
              <div className="employee-detail-heading">
                <div className="employee-identity">
                  <div className="rice-avatar">✦</div>
                  <div>
                    <p className="eyebrow">独立 AI员工</p>
                    <h2>{selected.currentVersion.manifest.name}</h2>
                    <p>{selected.currentVersion.manifest.description}</p>
                  </div>
                </div>
                {appShell ? (
                  <button
                    className="primary-action employee-start-action"
                    type="button"
                    onClick={() => appShell.navigate('workspace')}
                  >
                    和它开始工作 →
                  </button>
                ) : (
                  <Link
                    className="primary-action employee-start-action"
                    href={`/workspace?employeeId=${selected.id}`}
                  >
                    和它开始工作 →
                  </Link>
                )}
              </div>
              <div className="employee-detail-grid">
                <div className="employee-config-column">
                  <h3>工作方式</h3>
                  <label>
                    角色
                    <input
                      value={profile.role}
                      onChange={(event) =>
                        setProfile((current) => ({
                          ...current,
                          role: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    使命
                    <textarea
                      value={profile.mission}
                      onChange={(event) =>
                        setProfile((current) => ({
                          ...current,
                          mission: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    表达方式
                    <select
                      value={profile.communicationStyle}
                      onChange={(event) =>
                        setProfile((current) => ({
                          ...current,
                          communicationStyle: event.target.value as Style,
                        }))
                      }
                    >
                      <option value="structured">结构清晰</option>
                      <option value="concise">结论优先</option>
                      <option value="exploratory">展开比较</option>
                    </select>
                  </label>
                  <label>
                    主动程度
                    <select
                      value={profile.proactivePolicy}
                      onChange={(event) =>
                        setProfile((current) => ({
                          ...current,
                          proactivePolicy: event.target.value as Proactive,
                        }))
                      }
                    >
                      <option value="suggest">主动建议</option>
                      <option value="ask">先询问</option>
                      <option value="disabled">不主动建议</option>
                    </select>
                  </label>
                  <label>
                    执行确认边界
                    <select
                      value={profile.approvalPolicy}
                      onChange={(event) =>
                        setProfile((current) => ({
                          ...current,
                          approvalPolicy: event.target.value as Approval,
                        }))
                      }
                    >
                      <option value="confirm_side_effects">
                        有副作用的动作先确认
                      </option>
                      <option value="confirm_external">外部动作先确认</option>
                      <option value="autonomous">在授权范围内自动执行</option>
                    </select>
                    <small className="field-help">
                      这是员工的行为边界；权限仍由 Skill 和工作区策略决定。
                    </small>
                  </label>
                  <h3>可使用的 Skill</h3>
                  {hub.availableSkills.map((skill) => (
                    <label className="skill-choice" key={skill.skillVersionId}>
                      <input
                        type="checkbox"
                        checked={skills.includes(skill.skillVersionId)}
                        disabled={!skill.enabled || busy}
                        onChange={(event) =>
                          setSkills((current) =>
                            event.target.checked
                              ? [...new Set([...current, skill.skillVersionId])]
                              : current.filter(
                                  (id) => id !== skill.skillVersionId,
                                ),
                          )
                        }
                      />
                      <span>
                        {skill.name} · v{skill.version}
                      </span>
                    </label>
                  ))}
                  {!hub.availableSkills.length ? (
                    <p className="muted">先去 SkillHub 安装可用 Skill。</p>
                  ) : null}
                  <button
                    className="primary-action"
                    disabled={busy}
                    onClick={() => void saveEmployee()}
                  >
                    保存员工配置
                  </button>
                </div>
                <div className="employee-memory-column">
                  <div className="employee-memory-heading">
                    <div>
                      <h3>它记住的内容</h3>
                      <p>只属于这个 AI员工，会在后续对话中被检索。</p>
                    </div>
                    <strong>{memories.length}</strong>
                  </div>
                  <form className="employee-memory-form" onSubmit={saveMemory}>
                    <textarea
                      placeholder="例如：我的店铺核心指标是支付转化率和客单价。"
                      value={memoryDraft}
                      onChange={(event) => setMemoryDraft(event.target.value)}
                    />
                    <button
                      className="primary-action"
                      disabled={busy || !memoryDraft.trim()}
                    >
                      记住这条
                    </button>
                  </form>
                  <div className="employee-memory-list">
                    {memories.map((memory) => (
                      <article key={memory.id}>
                        <p>{memory.content}</p>
                        <small>
                          {new Date(memory.createdAt).toLocaleDateString()}
                        </small>
                      </article>
                    ))}
                    {!memories.length ? (
                      <p className="muted">还没有专属记忆。</p>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>
          ) : null}
          {error ? <p className="skillhub-error">{error}</p> : null}
        </div>
      </section>
    </main>
  );
}
