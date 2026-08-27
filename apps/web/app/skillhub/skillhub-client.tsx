'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { AppSidebar } from '../components/app-sidebar';
import { buildEmployeeCapabilityUpdate } from './employee-capabilities';

type Capability =
  | 'network:outbound'
  | 'storage:read'
  | 'storage:write'
  | 'secret:use'
  | 'model:invoke'
  | 'automation:write';

interface Version {
  version: {
    id: string;
    version: string;
    status: string;
    capabilities: Capability[];
  };
  artifact: { checksum: string; source: { license: string } };
}

interface CatalogSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  publisher: string;
  versions: Version[];
}

interface Installation {
  id: string;
  ownerId: string | null;
  catalogSkillId: string;
  pinnedVersionId: string;
  grantedCapabilities: Capability[];
  enabled: boolean;
}

interface Candidate {
  id: string;
  slug: string;
  name: string;
  description: string;
  publisher: string;
  version: string;
  capabilities: Capability[];
  source: { license: string };
}

interface EmployeeDirectoryEntry {
  employeeId: string;
  employeeKey: string;
  currentVersion: {
    manifest: {
      name: string;
    };
  };
}

interface EmployeeCapabilities {
  employeeId: string;
  agentSkills: {
    installationId: string;
    grantedCapabilities: Capability[];
    revision: { id: string };
    effective: boolean;
  }[];
  workflows: { revision: { id: string }; effective: boolean }[];
  knowledge: { revision: { id: string }; effective: boolean }[];
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

export function SkillHubClient() {
  const [workspaceId, setWorkspaceId] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [catalog, setCatalog] = useState<CatalogSkill[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [canAdminister, setCanAdminister] = useState(false);
  const [employees, setEmployees] = useState<EmployeeDirectoryEntry[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [employeeCapabilities, setEmployeeCapabilities] =
    useState<EmployeeCapabilities | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const headers = {
    'content-type': 'application/json',
    'x-allrice-organization-id': organizationId,
    'x-allrice-workspace-id': workspaceId,
  };

  const refresh = useCallback(async (nextWorkspaceId: string) => {
    const result = await json<{
      skillHub: {
        catalog: CatalogSkill[];
        installations: Installation[];
      };
      candidates: Candidate[];
      canAdminister: boolean;
    }>(
      await fetch(`/api/v1/skills?workspaceId=${nextWorkspaceId}`, {
        cache: 'no-store',
        headers: { 'x-allrice-workspace-id': nextWorkspaceId },
      }),
    );
    setCatalog(result.skillHub.catalog);
    setInstallations(result.skillHub.installations);
    setCandidates(result.candidates);
    setCanAdminister(result.canAdminister);
    if (result.canAdminister) {
      const employees = await json<{
        employeeHub: {
          directory: EmployeeDirectoryEntry[];
        };
      }>(
        await fetch(`/api/v1/employees?workspaceId=${nextWorkspaceId}`, {
          cache: 'no-store',
          headers: { 'x-allrice-workspace-id': nextWorkspaceId },
        }),
      );
      const nextEmployees = employees.employeeHub.directory;
      setEmployees(nextEmployees);
      setSelectedEmployeeId((current) =>
        nextEmployees.some((employee) => employee.employeeId === current)
          ? current
          : (nextEmployees.find(
              (employee) => employee.employeeKey === 'default-assistant',
            )?.employeeId ??
            nextEmployees[0]?.employeeId ??
            ''),
      );
    } else {
      setEmployees([]);
      setSelectedEmployeeId('');
    }
  }, []);

  const refreshEmployeeCapabilities = useCallback(
    async (employeeId: string, nextWorkspaceId: string) => {
      if (!employeeId || !nextWorkspaceId) {
        setEmployeeCapabilities(null);
        return;
      }
      const result = await json<{ capabilities: EmployeeCapabilities }>(
        await fetch(
          `/api/v1/employees/${employeeId}/capabilities?workspaceId=${nextWorkspaceId}`,
          {
            cache: 'no-store',
            headers: { 'x-allrice-workspace-id': nextWorkspaceId },
          },
        ),
      );
      setEmployeeCapabilities(result.capabilities);
    },
    [],
  );

  useEffect(() => {
    void (async () => {
      try {
        const workspace = await json<{
          workspace: { organizationId: string; workspaceId: string };
        }>(await fetch('/api/v1/workspace', { cache: 'no-store' }));
        setWorkspaceId(workspace.workspace.workspaceId);
        setOrganizationId(workspace.workspace.organizationId);
        await refresh(workspace.workspace.workspaceId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '加载失败');
      }
    })();
  }, [refresh]);

  useEffect(() => {
    setNotice('');
    setEmployeeCapabilities(null);
    if (!canAdminister || !selectedEmployeeId || !workspaceId) return;
    void refreshEmployeeCapabilities(selectedEmployeeId, workspaceId).catch(
      (cause) =>
        setError(
          cause instanceof Error ? cause.message : '员工能力配置加载失败',
        ),
    );
  }, [
    canAdminister,
    refreshEmployeeCapabilities,
    selectedEmployeeId,
    workspaceId,
  ]);

  async function importCandidate(candidateId: string) {
    setBusy(true);
    setError('');
    try {
      await json(
        await fetch('/api/v1/skills', {
          method: 'POST',
          headers,
          body: JSON.stringify({ candidateId, workspaceId }),
        }),
      );
      await refresh(workspaceId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }

  async function install(skill: CatalogSkill, version: Version) {
    setBusy(true);
    setError('');
    try {
      await json(
        await fetch('/api/v1/skills/installations', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            workspaceId,
            skillVersionId: version.version.id,
            scope: 'workspace',
            grantedCapabilities: version.version.capabilities,
            timeoutMs: 300_000,
            budgetCents: 0,
          }),
        }),
      );
      await refresh(workspaceId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '安装失败');
    } finally {
      setBusy(false);
    }
  }

  async function configureEmployee(
    installation: Installation,
    shouldBind: boolean,
  ) {
    const employee = employees.find(
      (item) => item.employeeId === selectedEmployeeId,
    );
    if (!employee || !employeeCapabilities) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const update = buildEmployeeCapabilityUpdate(
        employeeCapabilities,
        installation,
        shouldBind,
      );
      const result = await json<{ capabilities: EmployeeCapabilities }>(
        await fetch(`/api/v1/employees/${employee.employeeId}/capabilities`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            workspaceId,
            ...update,
          }),
        }),
      );
      setEmployeeCapabilities(result.capabilities);
      setNotice(
        shouldBind
          ? `已把技能配置给 ${employee.currentVersion.manifest.name}。`
          : `已从 ${employee.currentVersion.manifest.name} 移除技能。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配置 AI员工失败');
    } finally {
      setBusy(false);
    }
  }

  const importedSlugs = new Set(catalog.map((skill) => skill.slug));
  const selectedEmployee = employees.find(
    (employee) => employee.employeeId === selectedEmployeeId,
  );
  const selectedSkillVersionIds =
    employeeCapabilities?.agentSkills.map((binding) => binding.revision.id) ??
    [];
  return (
    <main className="app-page-shell">
      <AppSidebar
        active={null}
        action={
          <Link className="new-chat" href="/chatflow">
            ＋ 新建任务
          </Link>
        }
        className="app-page-sidebar"
        footer={<div className="app-sidebar-footer">管理员工作区</div>}
      />
      <section className="app-page-content">
        <div className="skillhub-shell">
          <header className="skillhub-header">
            <div>
              <p className="eyebrow">ALLRICE · SKILLHUB</p>
              <h1>技能底座</h1>
              <p className="lede">
                管理员审核并添加工作区技能，再决定每个 AI员工可以使用哪些能力。
              </p>
            </div>
            <Link href="/chatflow">返回与 Rice 工作</Link>
          </header>

          <section className="skillhub-section">
            <div className="section-heading">
              <h2>已审计导入源</h2>
              <p>
                只接收固定来源、许可证和校验和的技能，不执行来源仓库里的命令。
              </p>
            </div>
            <div className="skill-grid">
              {candidates.map((candidate) => (
                <article className="skill-card" key={candidate.id}>
                  <p className="eyebrow">{candidate.publisher}</p>
                  <h3>{candidate.name}</h3>
                  <p>{candidate.description}</p>
                  <small>{candidate.source.license} · 已审计导入源</small>
                  <button
                    className="primary-action"
                    disabled={
                      busy ||
                      importedSlugs.has(candidate.slug) ||
                      !canAdminister
                    }
                    onClick={() => void importCandidate(candidate.id)}
                  >
                    {importedSlugs.has(candidate.slug)
                      ? '已导入'
                      : canAdminister
                        ? '导入技能'
                        : '仅管理员可导入'}
                  </button>
                </article>
              ))}
            </div>
          </section>

          <section className="skillhub-section">
            <div className="section-heading">
              <h2>组织技能目录</h2>
              <p>
                工作区安装与员工配置分离，只有工作区和当前员工都授权时技能才会生效。
              </p>
            </div>
            <div className="employee-skill-config">
              <div>
                <p className="eyebrow">员工技能配置</p>
                <h3>选择要配置的 AI员工</h3>
                <p>为不同岗位配置不同技能，避免所有员工共享不必要的能力。</p>
              </div>
              <label>
                <span>当前员工</span>
                <select
                  aria-label="选择要配置技能的 AI员工"
                  disabled={!canAdminister || employees.length === 0}
                  value={selectedEmployeeId}
                  onChange={(event) =>
                    setSelectedEmployeeId(event.target.value)
                  }
                >
                  {employees.map((employee) => (
                    <option
                      key={employee.employeeId}
                      value={employee.employeeId}
                    >
                      {employee.currentVersion.manifest.name}
                    </option>
                  ))}
                </select>
              </label>
              <strong>
                当前已启用 {selectedSkillVersionIds.length} 项技能
              </strong>
            </div>
            <div className="skill-grid">
              {catalog.map((skill) => {
                const version = skill.versions[0];
                const installation = installations.find(
                  (item) =>
                    item.catalogSkillId === skill.id && item.ownerId === null,
                );
                return (
                  <article className="skill-card" key={skill.id}>
                    <p className="eyebrow">{skill.publisher}</p>
                    <h3>{skill.name}</h3>
                    <p>{skill.description}</p>
                    {version ? (
                      <>
                        <small>
                          {version.artifact.source.license} · 工作区可用
                        </small>
                        <div className="capability-list">
                          {version.version.capabilities.map((capability) => (
                            <span key={capability}>{capability}</span>
                          ))}
                        </div>
                        <button
                          className="primary-action"
                          disabled={
                            busy || Boolean(installation) || !canAdminister
                          }
                          onClick={() => void install(skill, version)}
                        >
                          {installation
                            ? '已添加到工作区'
                            : canAdminister
                              ? '添加到工作区'
                              : '仅管理员可添加'}
                        </button>
                        {installation ? (
                          <div className="installation-actions">
                            <button
                              disabled={
                                busy ||
                                !canAdminister ||
                                !selectedEmployee ||
                                !selectedEmployeeId ||
                                !employeeCapabilities
                              }
                              onClick={() =>
                                void configureEmployee(
                                  installation,
                                  !selectedSkillVersionIds.includes(
                                    installation.pinnedVersionId,
                                  ),
                                )
                              }
                            >
                              {selectedSkillVersionIds.includes(
                                installation.pinnedVersionId,
                              )
                                ? '从当前员工移除'
                                : '配置给当前员工'}
                            </button>
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </article>
                );
              })}
              {!catalog.length ? <p className="muted">尚未导入技能。</p> : null}
            </div>
          </section>

          {notice ? (
            <p className="skillhub-notice" role="status">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className="skillhub-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
