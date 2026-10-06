'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RepositoryCatalogSchema,
  RepairTaskSchema,
  type CreateRepairTaskSchema,
  type RepairTask,
} from '@allrice/database/technical-contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';
const endpoint = '/api/v1/admin/technical-assistant/repair';
const labels = {
  queued: '排队中',
  running: '修复与验证中',
  succeeded: '候选已验证',
  failed: '未完成',
  canceled: '已停止',
};
type Catalog = ReturnType<typeof RepositoryCatalogSchema.parse>;
type Submission = ReturnType<typeof CreateRepairTaskSchema.parse>;
export function PlatformRepositoryRepair() {
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [tasks, setTasks] = useState<RepairTask[]>([]),
    [baselineId, setBaselineId] = useState('');
  const [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<RepairTask | null>(null),
    [pending, setPending] = useState<Submission | null>(null),
    [writing, setWriting] = useState(false),
    [error, setError] = useState('');
  const mounted = useRef(false),
    sequence = useRef(0),
    selectedRef = useRef(selected);
  selectedRef.current = selected;
  const read = useCallback(async () => {
    const id = ++sequence.current,
      r = await fetch(endpoint, { cache: 'no-store' });
    if (!r.ok) throw Error('repair_unavailable');
    const rows = RepairTaskSchema.array()
      .max(20)
      .parse(await r.json());
    if (!mounted.current || id !== sequence.current) return rows;
    setTasks(rows);
    const selectedId = selectedRef.current;
    if (selectedId && !rows.some((q) => q.id === selectedId)) {
      const d = await fetch(endpoint + '/' + selectedId, { cache: 'no-store' });
      if (!d.ok) {
        if (
          mounted.current &&
          id === sequence.current &&
          selectedRef.current === selectedId
        )
          setDetail(null);
        throw Error('repair_detail_unavailable');
      }
      const q = RepairTaskSchema.parse(await d.json());
      if (
        mounted.current &&
        id === sequence.current &&
        selectedRef.current === selectedId
      )
        setDetail(q);
    }
    return rows;
  }, []);
  const readCatalog = useCallback(async () => {
    const r = await fetch(endpoint + '/baselines', { cache: 'no-store' });
    if (!r.ok) throw Error('catalog_unavailable');
    const c = RepositoryCatalogSchema.parse(await r.json());
    if (mounted.current) {
      setCatalog(c);
      setBaselineId((old) =>
        c.baselines.some((b) => b.id === old)
          ? old
          : (c.baselines[0]?.id ?? ''),
      );
    }
    return c;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void read().catch(() => {
      if (mounted.current) setError('修复记录暂不可读，请刷新核对。');
    });
    void readCatalog().catch(() => {
      if (mounted.current) setError('仓库基线暂不可读。');
    });
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, [read, readCatalog]);
  const current =
      tasks.find((q) => q.id === selected) ??
      (detail?.id === selected ? detail : null),
    hasActive =
      tasks.some((q) => ['queued', 'running'].includes(q.status)) ||
      !!(current && ['queued', 'running'].includes(current.status));
  const selectedBaseline = catalog?.baselines.find((b) => b.id === baselineId);
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(
      () =>
        void read().catch(() => {
          if (mounted.current) setError('状态更新暂未确认，原任务仍保留。');
        }),
      3000,
    );
    return () => clearInterval(timer);
  }, [hasActive, read]);
  async function find(request: Submission) {
    const r = await fetch(
      endpoint + '?requestId=' + encodeURIComponent(request.requestId),
      { cache: 'no-store' },
    );
    if (!r.ok) throw Error('repair_reconcile_unavailable');
    const q = RepairTaskSchema.nullable().parse((await r.json()).task);
    if (
      q &&
      (q.requestId !== request.requestId ||
        q.baseline.id !== request.baselineId ||
        q.verificationMode !== request.verificationMode ||
        q.reuseAcceptedTaskId !== request.reuseAcceptedTaskId)
    )
      throw Error('repair_request_changed');
    return q;
  }
  async function submit(reuseAcceptedTaskId?: string) {
    if (writing || (!pending && !baselineId)) return;
    const request = pending ?? {
      requestId: crypto.randomUUID(),
      baselineId,
      ...(selectedBaseline?.compiledDependencies
        ? { verificationMode: 'compiled_packages' as const }
        : {}),
      ...(reuseAcceptedTaskId ? { reuseAcceptedTaskId } : {}),
    };
    setPending(request);
    setWriting(true);
    setError('');
    let declined = false;
    try {
      let q = await find(request);
      if (!q) {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
        if (!r.ok) {
          declined = [400, 401, 403, 404, 409, 413, 422].includes(r.status);
          throw Error('repair_submit_unconfirmed');
        }
        q = RepairTaskSchema.parse(await r.json());
        if (
          q.requestId !== request.requestId ||
          q.baseline.id !== request.baselineId ||
          q.verificationMode !== request.verificationMode ||
          q.reuseAcceptedTaskId !== request.reuseAcceptedTaskId
        )
          throw Error('repair_request_changed');
      }
      if (mounted.current) {
        setSelected(q.id);
        setDetail(q);
        setPending(null);
      }
      await read();
    } catch {
      const q = await find(request).catch(() => undefined);
      if (mounted.current) {
        if (q) {
          setSelected(q.id);
          setDetail(q);
          setPending(null);
        } else if (q === null && declined) {
          setPending(null);
          setError('本次未启动修复，请刷新基线与记录后重试。');
          void readCatalog().catch(() => undefined);
        } else setError('提交结果尚未确认。请核对记录；重试会保留原请求编号。');
      }
    } finally {
      if (mounted.current) setWriting(false);
    }
  }
  async function stop() {
    if (!current || writing) return;
    setWriting(true);
    try {
      const r = await fetch(endpoint + '/' + current.id, { method: 'DELETE' });
      if (!r.ok) throw Error('stop_unconfirmed');
      const q = RepairTaskSchema.parse(await r.json());
      if (mounted.current) setDetail(q);
      await read();
    } catch {
      if (mounted.current)
        setError('停止结果尚未确认，请刷新核对，已有候选与记录会保留。');
    } finally {
      if (mounted.current) setWriting(false);
    }
  }
  async function refresh() {
    try {
      if (pending) {
        const q = await find(pending);
        if (q && mounted.current) {
          setSelected(q.id);
          setDetail(q);
          setPending(null);
          setError('');
        }
      }
      await Promise.all([read(), readCatalog()]);
      if (mounted.current && !pending) setError('');
    } catch {
      if (mounted.current) setError('修复记录暂不可读。');
    }
  }
  return (
    <section className={css.card} aria-label="仓库修复候选">
      <h3>仓库修复候选</h3>
      <p className={css.meta}>
        从登记的完整 AllRice
        源码生成受限候选，并复查同一组原始断言。支持命令输出遮盖模块；已登记编译环境时，同时验证两个包的编译产物。全仓构建与发布另行验证。
      </p>
      <div className={css.controls}>
        <label>
          源码基线{' '}
          <select
            value={baselineId}
            onChange={(e) => setBaselineId(e.target.value)}
            disabled={writing || !!pending}
            aria-label="源码基线"
          >
            <option value="">选择登记基线</option>
            {catalog?.baselines.map((b) => (
              <option key={b.id} value={b.id}>
                {b.sourceSha.slice(0, 10)} · {b.fileCount} 个文件
              </option>
            ))}
          </select>
        </label>
        <AdminButton
          disabled={writing || hasActive || (!pending && !baselineId)}
          onClick={() => void submit()}
        >
          {pending ? '核对并继续原请求' : '生成修复候选'}
        </AdminButton>
        <AdminButton disabled={writing} onClick={() => void refresh()}>
          刷新修复记录
        </AdminButton>
      </div>
      {catalog && catalog.state !== 'available' && (
        <p className={css.meta}>
          {catalog.state === 'not_configured'
            ? '尚未登记可信源码基线。'
            : '基线本次校验未通过，未启动修复。'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {tasks.length === 0 && <p className={css.meta}>尚无仓库修复记录。</p>}
      {tasks.map((q) => (
        <div className={css.record} key={q.id}>
          <div>
            <strong>候选修复 · {q.id.slice(0, 8)}</strong>
            <p className={css.meta}>
              {q.baseline.sourceSha.slice(0, 10)} · 候选 {q.candidate.revision}{' '}
              · {new Date(q.createdAt).toLocaleString('zh-CN')}
            </p>
          </div>
          <AdminStatus
            tone={
              q.accepted
                ? 'success'
                : q.status === 'failed'
                  ? 'warning'
                  : 'muted'
            }
          >
            {labels[q.status]}
          </AdminStatus>
          <AdminButton
            onClick={() => {
              setSelected(q.id);
              setDetail(q);
            }}
          >
            查看修复详情
          </AdminButton>
        </div>
      ))}
      {current && (
        <article aria-label="修复详情">
          <h4>
            {labels[current.status]} · {current.id.slice(0, 8)}
          </h4>
          <p className={css.meta}>
            实际员工版本 {current.employeeVersionId.slice(0, 8)} · 源码{' '}
            {current.baseline.sourceSha.slice(0, 10)} ·{' '}
            {current.baseline.fileCount} 个文件
          </p>
          <p className={css.meta}>
            {current.verificationMode === 'compiled_packages'
              ? '保留原锁文件与配置，只安装两个包所需的冻结依赖；验证实际编译产物，不代表全仓构建通过。'
              : '保留原锁文件与配置；本轮使用 Node 原生模块验证，没有安装全仓依赖。'}
          </p>
          {current.reuseAcceptedTaskId && (
            <p className={css.meta}>
              复用原候选 {current.reuseAcceptedTaskId.slice(0, 8)}
              ，在新任务中重新构建与验证，没有重新调用模型。
            </p>
          )}
          {current.errorCode && (
            <p role="status">任务未完成：{current.errorCode}</p>
          )}
          <div className={css.controls}>
            {current.accepted && (
              <AdminButton
                disabled={
                  writing ||
                  !!pending ||
                  hasActive ||
                  !selectedBaseline?.compiledDependencies ||
                  selectedBaseline.rootLockChecksum !==
                    current.baseline.rootLockChecksum ||
                  selectedBaseline.dependencyConfigurationDigest !==
                    current.baseline.dependencyConfigurationDigest
                }
                onClick={() => void submit(current.id)}
              >
                复验编译候选
              </AdminButton>
            )}
            {['queued', 'running'].includes(current.status) && (
              <AdminButton disabled={writing} onClick={() => void stop()}>
                停止修复
              </AdminButton>
            )}
            {current.report?.artifacts.map((a) => (
              <a
                key={a.artifactId}
                href={
                  endpoint + '/' + current.id + '/artifacts/' + a.artifactId
                }
              >
                {a.fileName}
              </a>
            ))}
          </div>
          {current.verifications.map((v) => (
            <details key={v.operationId}>
              <summary>
                {v.revision === 0 ? '修前基线' : '候选 ' + v.revision} ·{' '}
                {v.report.assertions.filter((a) => a.passed).length}/
                {v.report.assertions.length} 项通过 · 进程已停止并回收
              </summary>
              <p className={css.meta}>
                操作 {v.operationId} · {v.report.actualMaterialDigest}
              </p>
              {v.report.version === 2 && (
                <div>
                  <p className={css.meta}>
                    实际 Node {v.report.nodeVersion} · pnpm{' '}
                    {v.report.compiled.managerVersion} · TypeScript{' '}
                    {v.report.compiled.compilerVersion} · 离线安装 · 验证上限{' '}
                    {v.report.compiled.timeoutMs / 60_000} 分钟
                    {' · '}内存上限 {v.report.compiled.memoryMiB} MiB
                  </p>
                  {v.report.compiled.steps.map((s) => (
                    <p key={s.id}>
                      {s.status === 'passed'
                        ? '✓'
                        : s.status === 'failed'
                          ? '×'
                          : '—'}{' '}
                      {s.id === 'dependencies'
                        ? '冻结依赖安装'
                        : s.id === 'build_contracts'
                          ? 'contracts 包构建'
                          : 'project-runtime 包构建'}{' '}
                      ·{' '}
                      {s.status === 'not_run'
                        ? '未执行'
                        : `退出 ${s.exitCode ?? '未知'} · ${s.elapsedMs} ms`}
                    </p>
                  ))}
                  {v.report.compiled.packages.map((p) => (
                    <p key={p.name}>
                      {p.name} · {p.fileCount} 个编译文件 · {p.digest}
                    </p>
                  ))}
                  <p className={css.meta}>
                    回归目标：正式包导出 · {v.report.compiled.productionEntry}
                  </p>
                </div>
              )}
              {v.report.assertions.map((a) => (
                <p key={a.id}>
                  {a.passed ? '✓' : '×'} {a.id}
                </p>
              ))}
            </details>
          ))}
          <details>
            <summary>源码对比 · {current.source.path}</summary>
            <h5>原始文件</h5>
            <pre>{current.source.before}</pre>
            <h5>当前候选</h5>
            <pre>{current.source.after ?? '尚未生成候选'}</pre>
          </details>
          {current.accepted && (
            <p>
              {current.verificationMode === 'compiled_packages'
                ? '两个包编译与固定断言已通过，候选待审查。完整仓库构建、main 合并和 Dev 发布尚未执行。'
                : '固定断言已通过，候选待审查。完整构建、main 合并和 Dev 发布尚未执行。'}
            </p>
          )}
        </article>
      )}
    </section>
  );
}
