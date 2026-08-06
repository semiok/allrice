'use client';

import { useCallback, useEffect, useState } from 'react';

type Capability =
  | 'network:outbound'
  | 'storage:read'
  | 'storage:write'
  | 'secret:use'
  | 'model:invoke';

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
  const [riceEmployeeId, setRiceEmployeeId] = useState('');
  const [riceSkillVersionIds, setRiceSkillVersionIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
          assignments: {
            employeeId: string;
            employeeKey: string;
            currentVersion: { manifest: { skillVersionIds: string[] } };
          }[];
        };
      }>(
        await fetch(`/api/v1/employees?workspaceId=${nextWorkspaceId}`, {
          cache: 'no-store',
          headers: { 'x-allrice-workspace-id': nextWorkspaceId },
        }),
      );
      const rice = employees.employeeHub.assignments.find(
        (assignment) => assignment.employeeKey === 'default-assistant',
      );
      setRiceEmployeeId(rice?.employeeId ?? '');
      setRiceSkillVersionIds(
        rice?.currentVersion.manifest.skillVersionIds ?? [],
      );
    }
  }, []);

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

  async function configureRice(
    installation: Installation,
    shouldBind: boolean,
  ) {
    setBusy(true);
    setError('');
    try {
      const skillVersionIds = shouldBind
        ? [...new Set([...riceSkillVersionIds, installation.pinnedVersionId])]
        : riceSkillVersionIds.filter(
            (skillVersionId) => skillVersionId !== installation.pinnedVersionId,
          );
      await json(
        await fetch('/api/v1/employees', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            workspaceId,
            employeeId: riceEmployeeId,
            skillVersionIds,
          }),
        }),
      );
      await refresh(workspaceId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配置 Rice 失败');
    } finally {
      setBusy(false);
    }
  }

  const importedSlugs = new Set(catalog.map((skill) => skill.slug));
  return (
    <main className="skillhub-shell">
      <header className="skillhub-header">
        <div>
          <p className="eyebrow">ALLRICE · SKILLHUB</p>
          <h1>技能底座</h1>
          <p className="lede">
            管理员审核并添加工作区技能，再决定 Rice 可以使用哪些能力。
          </p>
        </div>
        <a href="/workspace">返回工作台</a>
      </header>

      <section className="skillhub-section">
        <div className="section-heading">
          <h2>已审计导入源</h2>
          <p>只接收固定来源、许可证和校验和的技能，不执行来源仓库里的命令。</p>
        </div>
        <div className="skill-grid">
          {candidates.map((candidate) => (
            <article className="skill-card" key={candidate.id}>
              <p className="eyebrow">{candidate.publisher}</p>
              <h3>{candidate.name}</h3>
              <p>{candidate.description}</p>
              <small>
                v{candidate.version} · {candidate.source.license}
              </small>
              <button
                className="primary-action"
                disabled={
                  busy || importedSlugs.has(candidate.slug) || !canAdminister
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
          <p>工作区安装与 Rice 配置分离，联网权限只有两边都允许时才生效。</p>
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
                      v{version.version.version} ·{' '}
                      {version.artifact.checksum.slice(0, 20)}…
                    </small>
                    <div className="capability-list">
                      {version.version.capabilities.map((capability) => (
                        <span key={capability}>{capability}</span>
                      ))}
                    </div>
                    <button
                      className="primary-action"
                      disabled={busy || Boolean(installation) || !canAdminister}
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
                          disabled={busy || !canAdminister || !riceEmployeeId}
                          onClick={() =>
                            void configureRice(
                              installation,
                              !riceSkillVersionIds.includes(
                                installation.pinnedVersionId,
                              ),
                            )
                          }
                        >
                          {riceSkillVersionIds.includes(
                            installation.pinnedVersionId,
                          )
                            ? '从 Rice 移除'
                            : '配置给 Rice'}
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

      {error ? <p className="skillhub-error">{error}</p> : null}
    </main>
  );
}
