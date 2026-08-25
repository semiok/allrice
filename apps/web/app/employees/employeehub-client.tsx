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

interface DirectoryEntry {
  employeeId: string;
  employeeKey: string;
  status: 'active' | 'archived';
  currentVersion: Version;
  assignedUserIds: string[];
}

interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member' | 'viewer';
}

interface Assignment {
  id: string;
  employeeId: string;
  employeeKey: string;
  isDefault: boolean;
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
  canAdminister: boolean;
  assignments: Assignment[];
  availableSkills: Skill[];
  directory: DirectoryEntry[];
  members: Member[];
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
  if (!response.ok) {
    throw new Error(
      (body as { error?: { message?: string } } | null)?.error?.message ??
        `请求失败（${response.status}）`,
    );
  }
  return body as T;
}

export function EmployeeHubClient({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const appShell = useAppShell();
  const [hub, setHub] = useState<Hub | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [profile, setProfile] = useState(defaultProfile);
  const [skills, setSkills] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selected = useMemo(
    () => hub?.directory.find((item) => item.employeeId === selectedEmployeeId),
    [hub, selectedEmployeeId],
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
    setSelectedEmployeeId((current) =>
      result.employeeHub.directory.some((item) => item.employeeId === current)
        ? current
        : (result.employeeHub.directory[0]?.employeeId ?? ''),
    );
  }, []);

  useEffect(() => {
    load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : '加载失败'),
    );
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    setProfile(selected.currentVersion.manifest.partnerProfile);
    setSkills(selected.currentVersion.manifest.skillVersionIds);
  }, [selected]);

  async function createEmployee(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hub || !createName.trim() || !createDescription.trim()) return;
    setBusy(true);
    setError('');
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
      setSelectedEmployeeId(result.employee.employeeId);
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
    setError('');
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

  async function setAssigned(userId: string, assigned: boolean) {
    if (!hub || !selected) return;
    const userIds = assigned
      ? [...new Set([...selected.assignedUserIds, userId])]
      : selected.assignedUserIds.filter((id) => id !== userId);
    setBusy(true);
    setError('');
    try {
      const result = await readJson<{ employeeHub: Hub }>(
        await fetch(`/api/v1/employees/${selected.employeeId}/assignments`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ workspaceId: hub.workspaceId, userIds }),
        }),
      );
      setHub(result.employeeHub);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '分配失败');
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus() {
    if (!hub || !selected) return;
    setBusy(true);
    setError('');
    try {
      await readJson(
        await fetch(`/api/v1/employees/${selected.employeeId}/status`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            workspaceId: hub.workspaceId,
            status: selected.status === 'active' ? 'archived' : 'active',
          }),
        }),
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '状态更新失败');
    } finally {
      setBusy(false);
    }
  }

  if (!hub) {
    return (
      <main className="workspace-loading">{error || '正在加载 AI员工…'}</main>
    );
  }

  const content = !hub.canAdminister ? (
    <div className="skillhub-shell employeehub-shell">
      <header className="skillhub-header">
        <div>
          <p className="eyebrow">ALLRICE · AI EMPLOYEES</p>
          <h1>AI员工由管理员配置</h1>
          <p className="lede">
            你不需要管理员工配置；已分配给你的员工会直接出现在工作台。
          </p>
        </div>
        {appShell ? (
          <button
            className="primary-action"
            type="button"
            onClick={() => appShell.navigate('workspace')}
          >
            返回工作台
          </button>
        ) : (
          <Link className="primary-action" href="/workspace">
            返回工作台
          </Link>
        )}
      </header>
    </div>
  ) : (
    <div className="skillhub-shell employeehub-shell independent-employee-shell">
      <header className="skillhub-header">
        <div>
          <p className="eyebrow">ALLRICE · EMPLOYEE ADMIN</p>
          <h1>AI员工配置</h1>
          <p className="lede">
            管理员工职责、行为边界、技能和成员分配。普通用户只负责使用。
          </p>
        </div>
        <div className="employee-header-actions">
          <button
            className="primary-action"
            type="button"
            onClick={() => setCreateOpen(true)}
          >
            ＋ 新建定制员工
          </button>
        </div>
      </header>

      <section className="employee-directory">
        <div className="partner-section-heading">
          <div>
            <p className="eyebrow">员工目录</p>
            <h2>选择员工进行配置</h2>
          </div>
          <span>{hub.directory.length} 位员工</span>
        </div>
        <div className="employee-directory-grid">
          {hub.directory.map((employee) => (
            <button
              className={
                employee.employeeId === selectedEmployeeId
                  ? 'employee-directory-card employee-directory-card-active'
                  : 'employee-directory-card'
              }
              key={employee.employeeId}
              onClick={() => setSelectedEmployeeId(employee.employeeId)}
              type="button"
            >
              <span className="employee-directory-avatar">✦</span>
              <span>
                <strong>{employee.currentVersion.manifest.name}</strong>
                <small>
                  {employee.currentVersion.manifest.partnerProfile.role}
                </small>
              </span>
              <em>{employee.status === 'active' ? '启用' : '停用'}</em>
            </button>
          ))}
        </div>
      </section>

      {createOpen ? (
        <section className="employee-create-panel">
          <div className="partner-section-heading">
            <div>
              <p className="eyebrow">新建定制员工</p>
              <h2>定义它长期负责的工作</h2>
            </div>
            <button type="button" onClick={() => setCreateOpen(false)}>
              取消
            </button>
          </div>
          <form className="employee-form" onSubmit={createEmployee}>
            <label>
              员工名称
              <input
                required
                maxLength={120}
                placeholder="例如：合同审查员"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
              />
            </label>
            <label>
              员工职责
              <textarea
                required
                maxLength={1000}
                placeholder="说明它负责什么、交付什么，以及不负责什么。"
                value={createDescription}
                onChange={(event) => setCreateDescription(event.target.value)}
              />
            </label>
            <button className="primary-action" disabled={busy} type="submit">
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
                <p className="eyebrow">员工定义</p>
                <h2>{selected.currentVersion.manifest.name}</h2>
                <p>{selected.currentVersion.manifest.description}</p>
              </div>
            </div>
            <button
              type="button"
              disabled={busy || selected.employeeKey === 'default-assistant'}
              onClick={() => void toggleStatus()}
            >
              {selected.status === 'active' ? '停用员工' : '重新启用'}
            </button>
          </div>
          <div className="employee-detail-grid">
            <div className="employee-config-column">
              <h3>人设与工作方式</h3>
              <label>
                角色
                <input
                  disabled={selected.status !== 'active'}
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
                  disabled={selected.status !== 'active'}
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
                  disabled={selected.status !== 'active'}
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
                执行确认边界
                <select
                  disabled={selected.status !== 'active'}
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
              </label>

              <h3>已配置 Skill</h3>
              {hub.availableSkills.map((skill) => (
                <label className="skill-choice" key={skill.skillVersionId}>
                  <input
                    type="checkbox"
                    checked={skills.includes(skill.skillVersionId)}
                    disabled={
                      !skill.enabled || busy || selected.status !== 'active'
                    }
                    onChange={(event) =>
                      setSkills((current) =>
                        event.target.checked
                          ? [...new Set([...current, skill.skillVersionId])]
                          : current.filter((id) => id !== skill.skillVersionId),
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
                disabled={busy || selected.status !== 'active'}
                type="button"
                onClick={() => void saveEmployee()}
              >
                保存员工配置
              </button>
            </div>

            <div className="employee-memory-column">
              <div className="employee-memory-heading">
                <div>
                  <h3>分配给成员</h3>
                  <p>成员被分配后，员工才会出现在其工作台。</p>
                </div>
                <strong>{selected.assignedUserIds.length}</strong>
              </div>
              {selected.employeeKey === 'default-assistant' ? (
                <p className="muted">
                  Rice 是默认通用员工，自动提供给所有成员。
                </p>
              ) : (
                <div className="employee-memory-list">
                  {hub.members.map((member) => (
                    <label className="skill-choice" key={member.userId}>
                      <input
                        type="checkbox"
                        checked={selected.assignedUserIds.includes(
                          member.userId,
                        )}
                        disabled={busy || selected.status !== 'active'}
                        onChange={(event) =>
                          void setAssigned(member.userId, event.target.checked)
                        }
                      />
                      <span>
                        {member.displayName || member.email}
                        <small>{member.email}</small>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}
      {error ? <p className="skillhub-error">{error}</p> : null}
    </div>
  );

  if (embedded) return <main className="employee-panel-only">{content}</main>;

  return (
    <main className="app-page-shell">
      <AppSidebar
        active="employees"
        action={
          <Link className="new-chat" href="/workspace">
            ＋ 新建任务
          </Link>
        }
        className="app-page-sidebar"
        footer={
          hub.canAdminister ? (
            <div className="app-sidebar-footer">
              <Link href="/skillhub">管理 AI员工技能</Link>
            </div>
          ) : null
        }
        showEmployeeAdmin={hub.canAdminister}
      />
      <section className="app-page-content">{content}</section>
    </main>
  );
}
