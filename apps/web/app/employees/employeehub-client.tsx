'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface Version {
  id: string;
  version: number;
  configChecksum: string;
  publishedAt: string;
  manifest: {
    name: string;
    description: string;
    provider: {
      provider: 'codex' | 'basic';
      model: string;
      reasoningEffort: string;
    };
    skillVersionIds: string[];
  };
}

interface Assignment {
  id: string;
  employeeId: string;
  employeeKey: string;
  isDefault: boolean;
  currentVersion: Version;
  versions: Version[];
}

interface AvailableSkill {
  skillVersionId: string;
  name: string;
  version: string;
  enabled: boolean;
}

interface EmployeeHub {
  organizationId: string;
  workspaceId: string;
  assignments: Assignment[];
  availableSkills: AvailableSkill[];
}

async function json<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('登录状态已失效');
  }
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

export function EmployeeHubClient() {
  const [hub, setHub] = useState<EmployeeHub | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const headers = useMemo(
    () => ({
      'content-type': 'application/json',
      'x-allrice-organization-id': hub?.organizationId ?? '',
      'x-allrice-workspace-id': hub?.workspaceId ?? '',
    }),
    [hub],
  );

  const refresh = useCallback(async () => {
    const result = await json<{ employeeHub: EmployeeHub }>(
      await fetch('/api/v1/employees', { cache: 'no-store' }),
    );
    setHub(result.employeeHub);
    const current = result.employeeHub.assignments.find(
      (assignment) => assignment.isDefault,
    );
    setSelectedSkills(current?.currentVersion.manifest.skillVersionIds ?? []);
  }, []);

  useEffect(() => {
    refresh().catch((cause) =>
      setError(cause instanceof Error ? cause.message : '加载失败'),
    );
  }, [refresh]);

  async function publish(assignment: Assignment) {
    if (!hub) return;
    setBusy(true);
    setError('');
    try {
      await json(
        await fetch('/api/v1/employees', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            workspaceId: hub.workspaceId,
            employeeId: assignment.employeeId,
            skillVersionIds: selectedSkills,
          }),
        }),
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发布失败');
    } finally {
      setBusy(false);
    }
  }

  async function assign(assignment: Assignment, employeeVersionId: string) {
    if (!hub) return;
    setBusy(true);
    setError('');
    try {
      await json(
        await fetch(`/api/v1/employees/${assignment.id}/version`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            workspaceId: hub.workspaceId,
            employeeVersionId,
          }),
        }),
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '切换版本失败');
    } finally {
      setBusy(false);
    }
  }

  if (!hub) {
    return (
      <main className="workspace-loading">{error || '正在加载 AI 员工…'}</main>
    );
  }

  return (
    <main className="skillhub-shell employeehub-shell">
      <header className="skillhub-header">
        <div>
          <p className="eyebrow">ALLRICE · EMPLOYEEHUB</p>
          <h1>AI 员工</h1>
          <p className="lede">
            默认员工由显式 Assignment
            决定；每次对话固定员工版本、模型与技能证据。
          </p>
        </div>
        <a href="/workspace">返回工作台</a>
      </header>

      {hub.assignments.map((assignment) => (
        <section className="employee-card" key={assignment.id}>
          <div className="employee-identity">
            <div className="rice-avatar">R</div>
            <div>
              <p className="eyebrow">
                {assignment.isDefault ? '默认通用员工' : 'AI 员工'}
              </p>
              <h2>{assignment.currentVersion.manifest.name}</h2>
              <p>{assignment.currentVersion.manifest.description}</p>
            </div>
          </div>
          <div className="employee-facts">
            <span>v{assignment.currentVersion.version}</span>
            <span>{assignment.currentVersion.manifest.provider.model}</span>
            <span>
              reasoning{' '}
              {assignment.currentVersion.manifest.provider.reasoningEffort}
            </span>
            <span>
              {assignment.currentVersion.manifest.skillVersionIds.length} 个技能
            </span>
          </div>

          <div className="employee-config-grid">
            <div>
              <h3>继承 SkillHub 能力</h3>
              {hub.availableSkills.map((skill) => (
                <label className="skill-choice" key={skill.skillVersionId}>
                  <input
                    type="checkbox"
                    disabled={busy || !skill.enabled}
                    checked={selectedSkills.includes(skill.skillVersionId)}
                    onChange={(event) =>
                      setSelectedSkills((current) =>
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
                <p className="muted">
                  先去 SkillHub 安装技能，Rice 也可无技能聊天。
                </p>
              ) : null}
              <button
                className="primary-action"
                disabled={busy}
                onClick={() => void publish(assignment)}
              >
                {busy ? '处理中…' : '发布并启用新版本'}
              </button>
            </div>

            <div>
              <h3>不可变版本历史</h3>
              <div className="employee-version-list">
                {assignment.versions.map((version) => (
                  <article key={version.id}>
                    <div>
                      <strong>v{version.version}</strong>
                      <span>{version.manifest.provider.model}</span>
                    </div>
                    <small>{version.configChecksum.slice(0, 22)}…</small>
                    <button
                      disabled={
                        busy ||
                        version.id === assignment.currentVersion.id ||
                        version.manifest.provider.provider !== 'codex'
                      }
                      onClick={() => void assign(assignment, version.id)}
                    >
                      {version.id === assignment.currentVersion.id
                        ? '当前版本'
                        : version.manifest.provider.provider !== 'codex'
                          ? '历史基础版本'
                          : '切换到此版本'}
                    </button>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>
      ))}
      {error ? <p className="skillhub-error">{error}</p> : null}
    </main>
  );
}
