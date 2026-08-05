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
  catalogSkillId: string;
  pinnedVersionId: string;
  grantedCapabilities: Capability[];
  enabled: boolean;
  favorite: boolean;
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

interface Provider {
  status: 'connected' | 'disconnected' | 'error' | 'unknown';
  cliVersion: string | null;
  detailCode: string | null;
  checkedAt: string | null;
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
  const [provider, setProvider] = useState<Provider | null>(null);
  const [prompt, setPrompt] = useState('纽约今天的天气怎么样？');
  const [run, setRun] = useState<{
    id: string;
    status: string;
    result?: unknown;
    error?: { message: string } | null;
  } | null>(null);
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
    }>(
      await fetch(`/api/v1/skills?workspaceId=${nextWorkspaceId}`, {
        cache: 'no-store',
        headers: { 'x-allrice-workspace-id': nextWorkspaceId },
      }),
    );
    setCatalog(result.skillHub.catalog);
    setInstallations(result.skillHub.installations);
    setCandidates(result.candidates);
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
        const status = await fetch('/api/v1/admin/providers/codex', {
          cache: 'no-store',
        });
        if (status.ok) {
          setProvider((await status.json()).provider as Provider);
        }
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

  async function execute(installation: Installation) {
    setBusy(true);
    setRun(null);
    setError('');
    try {
      const created = await json<{ run: { id: string; status: string } }>(
        await fetch('/api/v1/skills/runs', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            workspaceId,
            installationId: installation.id,
            prompt,
            idempotencyKey: crypto.randomUUID(),
          }),
        }),
      );
      setRun(created.run);
      for (let attempt = 0; attempt < 150; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const result = await json<{
          run: {
            id: string;
            status: string;
            result?: unknown;
            error?: { message: string } | null;
          };
        }>(
          await fetch(
            `/api/v1/runs/${created.run.id}?workspaceId=${workspaceId}`,
            { cache: 'no-store', headers },
          ),
        );
        setRun(result.run);
        if (['succeeded', 'failed', 'canceled'].includes(result.run.status)) {
          break;
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '运行失败');
    } finally {
      setBusy(false);
    }
  }

  async function updateInstallation(
    installation: Installation,
    update: { enabled?: boolean; favorite?: boolean },
  ) {
    setBusy(true);
    setError('');
    try {
      await json(
        await fetch(`/api/v1/skills/installations/${installation.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ workspaceId, ...update }),
        }),
      );
      await refresh(workspaceId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新安装失败');
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
            技能按不可变版本安装；当前唯一执行提供方是 Codex 订阅授权。
          </p>
        </div>
        <a href="/workspace">返回工作台</a>
      </header>

      <section className="provider-card">
        <div>
          <span
            className={`provider-dot provider-${provider?.status ?? 'unknown'}`}
          />
          <strong>Codex · ChatGPT subscription</strong>
        </div>
        <p>
          {provider?.status ?? 'unknown'} ·{' '}
          {provider?.cliVersion ?? provider?.detailCode ?? '等待 Worker 检查'}
        </p>
      </section>

      <section className="skillhub-section">
        <div className="section-heading">
          <h2>已审计导入源</h2>
          <p>只导入单个技能，不复制 OpenRice 的桌面加载器或用户配置。</p>
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
                disabled={busy || importedSlugs.has(candidate.slug)}
                onClick={() => void importCandidate(candidate.id)}
              >
                {importedSlugs.has(candidate.slug)
                  ? '已导入'
                  : '导入不可变版本'}
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="skillhub-section">
        <div className="section-heading">
          <h2>组织技能目录</h2>
          <p>安装时显式授予能力，运行固定到 checksum 对应的版本。</p>
        </div>
        <div className="skill-grid">
          {catalog.map((skill) => {
            const version = skill.versions[0];
            const installation = installations.find(
              (item) => item.catalogSkillId === skill.id,
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
                      disabled={busy || Boolean(installation)}
                      onClick={() => void install(skill, version)}
                    >
                      {installation ? '已安装并固定版本' : '安装并授权'}
                    </button>
                    {installation ? (
                      <div className="installation-actions">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void updateInstallation(installation, {
                              favorite: !installation.favorite,
                            })
                          }
                        >
                          {installation.favorite ? '★ 已收藏' : '☆ 收藏'}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void updateInstallation(installation, {
                              enabled: !installation.enabled,
                            })
                          }
                        >
                          {installation.enabled ? '停用' : '启用'}
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

      {installations.some((installation) => installation.enabled) ? (
        <section className="skill-runner">
          <div className="section-heading">
            <h2>Codex SkillRun</h2>
            <p>该入口用于验收 SkillHub；AI 员工组合将在后续 Issue 接入。</p>
          </div>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <button
            className="primary-action"
            disabled={busy || !prompt.trim()}
            onClick={() =>
              void execute(
                installations.find((installation) => installation.enabled)!,
              )
            }
          >
            {busy ? '运行中…' : '运行已安装技能'}
          </button>
          {run ? <pre>{JSON.stringify(run, null, 2)}</pre> : null}
        </section>
      ) : null}
      {error ? <p className="skillhub-error">{error}</p> : null}
    </main>
  );
}
