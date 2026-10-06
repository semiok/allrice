'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RepositoryPublicationSchema,
  PlatformRepositoryCredentialSchema,
  type RepositoryPublication,
  type RepairTask,
} from '@allrice/database/technical-contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';
import { PlatformRepositoryReviews } from './platform-repository-reviews';
const endpoint = '/api/v1/admin/technical-assistant/repository-publications';
type Request =
  | {
      action: 'publish';
      requestId: string;
      repairTaskId: string;
      credentialRevision: number;
    }
  | {
      action: 'inspect';
      requestId: string;
      publicationId: string;
      credentialRevision: number;
    };
const actionLabels = {
  queued: '排队中',
  running: '处理中',
  succeeded: '操作已完成',
  failed: '未完成',
  canceled: '已停止',
};
const ciLabels = {
  not_observed: '尚未读取 CI',
  pending: 'CI 进行中',
  unknown: 'CI 尚无法确认',
  failed: 'CI 未通过',
  stale: '版本已变化，需要复验',
  passed: '四项 CI 已通过',
};
export function PlatformRepositoryPublications({
  repair,
  currentBaseline,
}: {
  repair: RepairTask | null;
  currentBaseline: boolean;
}) {
  const [rows, setRows] = useState<RepositoryPublication[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<RepositoryPublication | null>(null);
  const [credential, setCredential] = useState<ReturnType<
      typeof PlatformRepositoryCredentialSchema.parse
    > | null>(null),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Request | null>(null),
    [notice, setNotice] = useState('');
  const mounted = useRef(false),
    sequence = useRef(0),
    selectedRef = useRef(selected),
    repairIdRef = useRef(repair?.id);
  selectedRef.current = selected;
  repairIdRef.current = repair?.id;
  const read = useCallback(async () => {
    const epoch = ++sequence.current;
    const [list, config] = await Promise.all([
      fetch(endpoint, { cache: 'no-store' }),
      fetch('/api/v1/admin/technical-assistant/repository-credential', {
        cache: 'no-store',
      }),
    ]);
    if (!list.ok || !config.ok) throw Error('repository_unavailable');
    const publications = RepositoryPublicationSchema.array()
        .max(50)
        .parse(await list.json()),
      settings = PlatformRepositoryCredentialSchema.parse(await config.json());
    let extra: RepositoryPublication | null = null;
    const id = selectedRef.current;
    if (id && !publications.some((p) => p.id === id)) {
      const r = await fetch(endpoint + '/' + id, { cache: 'no-store' });
      if (!r.ok) throw Error('publication_unavailable');
      extra = RepositoryPublicationSchema.parse(await r.json());
    }
    if (mounted.current && sequence.current === epoch) {
      setRows(publications);
      setCredential(settings);
      setDetail(extra);
      if (!selectedRef.current) {
        const match = publications.find(
          (p) => p.repairTaskId === repairIdRef.current,
        );
        if (match) {
          setSelected(match.id);
          selectedRef.current = match.id;
        }
      }
    }
    return publications;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void read().catch(() => {
      if (mounted.current) setNotice('发布记录暂不可读，请刷新核对。');
    });
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, [read]);
  useEffect(() => {
    setSelected(rows.find((p) => p.repairTaskId === repair?.id)?.id ?? null);
  }, [repair?.id]);
  const current =
      rows.find((p) => p.id === selected) ??
      (detail?.id === selected ? detail : null),
    active = current?.actions.find(
      (a) => a.status === 'queued' || a.status === 'running',
    );
  useEffect(() => {
    if (
      !rows.some((p) =>
        p.actions.some((a) => a.status === 'queued' || a.status === 'running'),
      ) &&
      !active
    )
      return;
    const timer = setInterval(
      () =>
        void read().catch(() => {
          if (mounted.current) setNotice('状态更新暂未确认，原操作仍保留。');
        }),
      3000,
    );
    return () => clearInterval(timer);
  }, [rows, active, read]);
  async function reconcile(request: Request) {
    const r = await fetch(
      endpoint + '?requestId=' + encodeURIComponent(request.requestId),
      { cache: 'no-store' },
    );
    if (!r.ok) throw Error('request_unknown');
    const p = RepositoryPublicationSchema.nullable().parse(
      (await r.json()).publication,
    );
    if (
      p &&
      (!p.actions.some(
        (a) => a.requestId === request.requestId && a.action === request.action,
      ) ||
        (request.action === 'publish'
          ? p.repairTaskId !== request.repairTaskId
          : p.id !== request.publicationId))
    )
      throw Error('request_changed');
    return p;
  }
  function apply(p: RepositoryPublication) {
    sequence.current++;
    setDetail(p);
    setRows((old) => [p, ...old.filter((q) => q.id !== p.id)].slice(0, 50));
    setSelected(p.id);
    selectedRef.current = p.id;
    setPending(null);
  }
  async function submit(action: 'publish' | 'inspect') {
    if (
      busy ||
      pending ||
      !credential ||
      credential.state !== 'configured' ||
      active
    )
      return;
    if (
      action === 'publish' &&
      (!repair?.accepted ||
        repair.verificationMode !== 'compiled_packages' ||
        !currentBaseline)
    )
      return;
    if (action === 'inspect' && !current) return;
    const request: Request =
      action === 'publish'
        ? {
            action,
            requestId: crypto.randomUUID(),
            repairTaskId: repair!.id,
            credentialRevision: credential.revision,
          }
        : {
            action,
            requestId: crypto.randomUUID(),
            publicationId: current!.id,
            credentialRevision: credential.revision,
          };
    sequence.current++;
    setPending(request);
    setBusy(true);
    setNotice('');
    let declined = false;
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      declined = r.status >= 400 && r.status < 500;
      if (!r.ok) throw Error('submission_unknown');
      const p = RepositoryPublicationSchema.parse(await r.json());
      if (mounted.current) apply(p);
    } catch {
      if (!declined) {
        try {
          const p = await reconcile(request);
          if (p && mounted.current) {
            apply(p);
            setNotice('已找到原操作，未重复提交。');
            return;
          }
        } catch {
          // Preserve the pending request when its read-back is unavailable.
        }
      }
      if (mounted.current) {
        if (declined) setPending(null);
        setNotice(
          declined
            ? '操作被拒绝，请核对当前版本、登录和仓库授权。'
            : '提交结果尚未确认，请核对原请求；不会自动重新提交。',
        );
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function checkPending() {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const p = await reconcile(pending);
      if (p && mounted.current) {
        apply(p);
        setNotice('已找到原操作，未重复提交。');
      } else if (mounted.current) setNotice('尚未找到原请求，结果仍未确认。');
    } catch {
      if (mounted.current) setNotice('原请求暂无法核对。');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function stop() {
    if (!current || !active || busy) return;
    sequence.current++;
    setBusy(true);
    try {
      const r = await fetch(
        endpoint + '/' + current.id + '?actionId=' + active.id,
        { method: 'DELETE' },
      );
      if (!r.ok) throw Error('stop_unknown');
      const p = RepositoryPublicationSchema.parse(await r.json());
      if (mounted.current) apply(p);
    } catch {
      if (mounted.current) setNotice('停止结果尚未确认，请刷新原操作。');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const eligible =
    !!repair?.accepted &&
    repair.verificationMode === 'compiled_packages' &&
    currentBaseline;
  return (
    <section aria-label="候选仓库发布">
      <h4>提交候选修复</h4>
      <p>
        将已验证的候选提交到 AllRice 仓库，创建草稿 PR，并读取对应版本的完整
        CI。
      </p>
      <div className={css.controls}>
        <AdminButton
          disabled={busy}
          onClick={() =>
            void read().catch(() => setNotice('发布记录暂不可读。'))
          }
        >
          刷新发布记录
        </AdminButton>
        <AdminButton
          disabled={
            busy ||
            !!pending ||
            !!active ||
            !eligible ||
            credential?.state !== 'configured'
          }
          onClick={() => void submit('publish')}
        >
          提交候选到 GitHub
        </AdminButton>
        {pending && (
          <AdminButton disabled={busy} onClick={() => void checkPending()}>
            核对原请求
          </AdminButton>
        )}
      </div>
      {repair?.accepted && !eligible && (
        <p>请先在当前基线复验编译候选，再提交。</p>
      )}
      {credential?.state !== 'configured' && (
        <p>请先在「平台仓库授权」中配置当前管理员的仓库令牌。</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {rows.length > 0 && (
        <label>
          发布记录{' '}
          <select
            value={selected ?? ''}
            onChange={(e) => setSelected(e.target.value || null)}
          >
            <option value="">选择发布记录</option>
            {rows.map((p) => (
              <option key={p.id} value={p.id}>
                {p.remote ? 'PR #' + p.remote.number : p.id.slice(0, 8)} ·{' '}
                {p.createdAt}
              </option>
            ))}
          </select>
        </label>
      )}
      {current && (
        <article>
          <p>
            基线 {current.baseSha.slice(0, 12)} · 候选{' '}
            {current.candidateChecksum.slice(7, 19)}
          </p>
          {current.remote && (
            <p>
              <a href={current.remote.url} target="_blank" rel="noreferrer">
                GitHub PR #{current.remote.number}
              </a>{' '}
              · Head {current.remote.headSha.slice(0, 12)}
            </p>
          )}
          <p>
            <AdminStatus
              tone={
                current.ci.state === 'passed'
                  ? 'success'
                  : current.ci.state === 'failed'
                    ? 'danger'
                    : 'muted'
              }
            >
              {ciLabels[current.ci.state]}
            </AdminStatus>
          </p>
          {current.ci.observedAt && (
            <p className={css.meta}>
              CI 核对时间 {new Date(current.ci.observedAt).toLocaleString()}
            </p>
          )}
          {current.ci.workflowRunId && (
            <p>
              <a
                href={
                  'https://github.com/semiok/allrice/actions/runs/' +
                  current.ci.workflowRunId
                }
                target="_blank"
                rel="noreferrer"
              >
                CI Run {current.ci.workflowRunId} · 第 {current.ci.runAttempt}{' '}
                次
              </a>
            </p>
          )}
          {current.ci.checkoutSha && (
            <p className={css.meta}>
              实际测试提交 {current.ci.checkoutSha} · 树{' '}
              {current.ci.checkoutTree}
            </p>
          )}
          {current.ci.checks.map((check) => (
            <p key={check.name}>
              {check.name} · {check.conclusion}
            </p>
          ))}
          <div className={css.controls}>
            <AdminButton
              disabled={
                busy ||
                !!pending ||
                !!active ||
                credential?.state !== 'configured'
              }
              onClick={() => void submit('inspect')}
            >
              核对远端与 CI
            </AdminButton>
            {active && (
              <AdminButton disabled={busy} onClick={() => void stop()}>
                停止当前操作
              </AdminButton>
            )}
          </div>
          <details>
            <summary>发布步骤与操作记录</summary>
            {current.steps.map((s) => (
              <p key={s.step}>
                {s.step} ·{' '}
                {s.state === 'confirmed'
                  ? '已确认'
                  : s.state === 'started'
                    ? '已发出，等待确认'
                    : '尚未发出'}
              </p>
            ))}
            {current.actions.map((a) => (
              <p key={a.id}>
                {a.action === 'publish' ? '提交候选' : '核对远端'} ·{' '}
                {actionLabels[a.status]}
                {a.errorCode ? ' · ' + a.errorCode : ''}
              </p>
            ))}
          </details>
          <p className={css.meta}>
            CI 通过后仍需独立审查；合并 main 和部署 Dev 是后续操作。
          </p>
          <PlatformRepositoryReviews
            key={current.id}
            publicationId={current.id}
            credentialRevision={
              credential?.state === 'configured' ? credential.revision : null
            }
          />
        </article>
      )}
    </section>
  );
}
