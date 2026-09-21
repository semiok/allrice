'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  TenantValidationSummary,
  TenantRunInspection,
} from '@allrice/contracts';
import {
  capabilityLabels,
  capabilityReasons,
  capabilityStateLabels,
} from '../chatflow/capability-catalog';
import {
  ReadOnlyArtifactPreview,
  SafeDocument,
} from '../chatflow/artifact-workbench';
import {
  parseArtifactPreview,
  type ArtifactPreview,
} from '../../lib/chatflow/workbench-model';
import { RunUsageSummary } from './run-usage';
import { DevelopmentInspection } from './development-inspection';
import type { TenantResourceProps } from './tenant-resource-editor';
import styles from './tenant-administration.module.css';

export function TenantValidation(
  props: TenantResourceProps & { subjectId: string },
) {
  const { organizationId, workspaceId, subjectId } = props;
  const [data, setData] = useState<TenantValidationSummary | null>(null),
    [detail, setDetail] = useState<TenantRunInspection | null>(null);
  const [deviceId, setDevice] = useState(''),
    [runId, setRun] = useState(''),
    [artifactId, setArtifact] = useState(''),
    [preview, setPreview] = useState<ArtifactPreview | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const base = `/api/v1/admin/tenants/${organizationId}/validation?workspaceId=${workspaceId}&subjectId=${subjectId}`;
  const read = useCallback(
    async <
      T extends {
        organizationId: string;
        workspaceId: string;
        subjectId: string;
      },
    >(
      url: string,
      signal: AbortSignal,
    ): Promise<T> => {
      const response = await fetch(url, { cache: 'no-store', signal }),
        body = await response.json().catch(() => {
          throw Error('验收接口未返回有效数据，请检查服务版本或稍后刷新。');
        });
      if (!response.ok)
        throw Error(
          body.error?.message ??
            '读取失败，请检查权限或稍后刷新；未知不代表可用。',
        );
      if (
        body.organizationId !== organizationId ||
        body.workspaceId !== workspaceId ||
        body.subjectId !== subjectId
      )
        throw Error('响应不属于所选租户/使用者，已拒绝显示。');
      return body;
    },
    [organizationId, workspaceId, subjectId],
  );
  const refresh = useCallback(async () => {
    request.current?.abort();
    const c = new AbortController();
    request.current = c;
    setLoading(true);
    setError('');
    setDetail(null);
    setPreview(null);
    setArtifact('');
    try {
      const value = await read<TenantValidationSummary>(
        base + (deviceId ? `&deviceId=${deviceId}` : ''),
        c.signal,
      );
      if (!c.signal.aborted) setData(value);
    } catch (e) {
      if (!c.signal.aborted) {
        setData(null);
        setError(e instanceof Error ? e.message : '读取失败');
      }
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, [base, deviceId, read]);
  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);
  async function inspect(id: string) {
    request.current?.abort();
    const c = new AbortController();
    request.current = c;
    setRun(id);
    setDetail(null);
    setPreview(null);
    setArtifact('');
    setError('');
    setLoading(true);
    try {
      const value = await read<TenantRunInspection>(
        `${base}&runId=${encodeURIComponent(id)}`,
        c.signal,
      );
      if (value.run.id !== id) throw Error('Run 范围不匹配');
      if (!c.signal.aborted) setDetail(value);
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : 'Run 读取失败');
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }
  async function inspectArtifact(id: string) {
    request.current?.abort();
    const c = new AbortController();
    request.current = c;
    setArtifact(id);
    setPreview(null);
    setError('');
    setLoading(true);
    try {
      const value = await read<{
        organizationId: string;
        workspaceId: string;
        subjectId: string;
        runId: string;
        artifactId: string;
        preview: unknown;
      }>(`${base}&runId=${runId}&artifactId=${id}`, c.signal);
      if (value.runId !== runId || value.artifactId !== id)
        throw Error('工件范围不匹配');
      if (!c.signal.aborted) setPreview(parseArtifactPreview(value.preview));
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : '预览失败');
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }
  return (
    <section aria-label="租户验收与交付">
      <h3>验收与交付</h3>
      <p>
        这里检查实际使用者的配置与历史结果，不冒用其身份发起任务、批准操作或借用其设备。调试页的模型试用成功不能替代租户本人验收。
      </p>
      <button disabled={loading} onClick={() => void refresh()}>
        刷新配置与就绪检查
      </button>
      {loading ? <p role="status">读取中…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {data ? (
        <>
          <p>
            实际查看人：{data.inspectorId}；实际使用者：{subjectId}；检查时间：
            {new Date(data.observedAt).toLocaleString()}
          </p>
          <label>
            观察设备（不修改执行绑定）
            <select
              aria-label="验收观察设备"
              value={deviceId}
              disabled={loading}
              onChange={(e) => setDevice(e.target.value)}
            >
              <option value="">云端 / 不限定设备</option>
              {data.environments.devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.status === 'online' ? '最近心跳在线' : '离线'}
                </option>
              ))}
            </select>
          </label>
          <p>
            策略版本：{data.policyVersion ?? '未配置'}
            。能力矩阵按使用者全部设备检查；选择观察设备不会让任务改用另一台设备，实际绑定见下方结果。
          </p>
          <h4>后续新 Run 的有效员工版本</h4>
          {data.assignments.length ? (
            data.assignments.map((a) => (
              <p key={a.id}>
                {a.name} · v{a.version} · {a.versionId}
                {a.isDefault ? ' · 默认' : ''}
              </p>
            ))
          ) : (
            <p>没有有效员工分配，请先发布并分配 Rice。</p>
          )}
          <p>
            新 Run 使用当前分配，运行中或历史 Run
            的冻结版本不随发布改变；回退配置也不会回放旧操作。
          </p>
          <nav>
            <a
              href={`/runtime-console?view=tenants&organizationId=${organizationId}&workspaceId=${workspaceId}&tenantView=policy`}
            >
              执行策略与角色配置
            </a>
            {' · '}
            <a
              href={`/runtime-console?view=tenants&organizationId=${organizationId}&workspaceId=${workspaceId}&tenantView=environments&subjectId=${subjectId}`}
            >
              环境 / MCP / 设备指引
            </a>
            {' · '}
            <a
              href={`/runtime-console?view=employees&workspaceId=${workspaceId}`}
            >
              Rice 发布与回退
            </a>
            {' · '}
            <a
              href={`/runtime-console?view=tenants&organizationId=${organizationId}&workspaceId=${workspaceId}&tenantView=quotas&subjectId=${subjectId}`}
            >
              调整内部额度
            </a>
          </nav>
          <div className={styles.tableScroll}>
            <table>
              <thead>
                <tr>
                  <th>能力</th>
                  <th>当前全部条件</th>
                  <th>处理责任</th>
                </tr>
              </thead>
              <tbody>
                {data.environments.prerequisites.map((reasons) => (
                  <tr key={reasons[0]!.id}>
                    <td>{capabilityLabels[reasons[0]!.id].title}</td>
                    <td>
                      {reasons.map((r, i) => (
                        <p key={i}>
                          {capabilityStateLabels[r.state]} ·{' '}
                          {capabilityReasons[r.reason]}
                        </p>
                      ))}
                    </td>
                    <td>
                      {[
                        ...new Set(
                          reasons.map((r) =>
                            r.responsibleRole === 'user'
                              ? '使用者 / 设备主人'
                              : r.responsibleRole === 'platform_admin'
                                ? '平台运维 / 管理员'
                                : '平台管理员配置',
                          ),
                        ),
                      ].join('；')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h4>内部额度预检</h4>
          {data.quotaError ? (
            <p role="alert">
              额度读取失败：可用余额未知，不代表
              0，也不保证任务可以执行。请刷新或检查后台服务。
            </p>
          ) : (
            data.quotas?.quotas.map((q) => (
              <p key={q.scope}>
                {q.scope === 'organization'
                  ? '组织'
                  : q.scope === 'tenant'
                    ? '租户资源'
                    : '所选用户'}
                ：已记录 {q.usedTokens.toLocaleString()} / 上限{' '}
                {q.effective.monthlyTokenLimit.toLocaleString()} Token；风险预留{' '}
                {q.reservedTokens.toLocaleString()}；
                {q.usedTokens + q.reservedTokens >=
                q.effective.monthlyTokenLimit
                  ? '已达内部额度，请检查限制'
                  : '仍需执行时准入'}
                （{q.usageScope === 'workspace' ? '当前工作区统计' : '组织统计'}
                ）
              </p>
            ))
          )}
          <p>
            以上不是 Codex
            官方订阅余额，也不是一次执行许可。真实任务由该使用者登录自己的租户前台发起；本页没有代执行按钮。
          </p>
          <h4>实际任务与交付物</h4>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void inspect(runId.trim());
            }}
          >
            <label>
              Run ID
              <select
                aria-label="选择验收 Run"
                value={data.runs.some((r) => r.id === runId) ? runId : ''}
                disabled={loading}
                onChange={(e) => {
                  if (e.target.value) void inspect(e.target.value);
                }}
              >
                <option value="">选择实际使用者的任务</option>
                {data.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id.slice(0, 8)} · {r.status} · {r.title}
                  </option>
                ))}
              </select>
              <input
                aria-label="完整验收 Run ID"
                value={runId}
                disabled={loading}
                onChange={(e) => {
                  setRun(e.target.value);
                  setDetail(null);
                  setPreview(null);
                }}
                placeholder="粘贴完整 Run ID，可检查列表外的旧任务"
              />
            </label>
            <button disabled={loading || !runId.trim()}>检查此 Run</button>
          </form>
          {data.runsTruncated ? (
            <p>列表仅显示最近 50 次；历史任务可粘贴完整 ID，仍逐次校验归属。</p>
          ) : null}
        </>
      ) : null}
      {detail ? (
        <section aria-label="真实任务检查结果">
          <h4>
            Run {detail.run.id.slice(0, 8)} · {detail.run.status}
          </h4>
          <p>
            冻结员工版本：{detail.run.employeeVersionId}；Session：
            {detail.run.sessionId}
          </p>
          <RunUsageSummary usage={detail.usage} runStatus={detail.run.status} />
          {detail.development ? (
            <DevelopmentInspection data={detail.development} />
          ) : null}
          <details>
            <summary>用户目标与交付回复</summary>
            <SafeDocument text={detail.userText ?? '无可展示目标'} />
            <SafeDocument text={detail.answerText ?? '尚无回复'} />
          </details>
          <details>
            <summary>运行摘要（不展示隐藏推理或原始参数）</summary>
            <p>仅展示最近 150 条事件中的可公开摘要；不作为完整审计日志。</p>
            {detail.events.map((e, i) => (
              <p key={`${e.key}-${i}`}>
                {e.title} · {e.status}
                {e.detail ? ` · ${e.detail}` : ''}
              </p>
            ))}
          </details>
          <h5>实际执行与审批</h5>
          {detail.operations.map((o) => (
            <article key={o.id}>
              <strong>
                {o.action} · {o.status}
              </strong>
              <p>
                Operation {o.id} · 实际设备 {o.deviceId ?? '云端'} · Target{' '}
                {o.targetId}
              </p>
              {deviceId && o.deviceId !== deviceId ? (
                <p role="alert">
                  此操作绑定的不是当前观察设备，不能作为所选设备通过的证据。
                </p>
              ) : null}
              <p>
                审批：{o.approval ?? '无单次审批记录'}
                {o.expiresAt
                  ? ` · 到期 ${new Date(o.expiresAt).toLocaleString()}`
                  : ''}
                。已批不代表已执行；结果未知不重放。
              </p>
              {o.output ? (
                <details>
                  <summary>命令输出前缀（只读、有界）</summary>
                  <pre>{o.output}</pre>
                  {o.outputTruncated ? (
                    <p>输出已截断，完整记录保留在原执行日志。</p>
                  ) : null}
                </details>
              ) : null}
            </article>
          ))}
          {!detail.operations.length ? (
            <p>
              没有受控执行记录；不能把文本回复当作本地落盘或浏览器操作证据。
            </p>
          ) : null}
          {detail.operationsTruncated ? (
            <p>只显示前 32 个操作，其余请到完整任务记录查看。</p>
          ) : null}
          <h5>真实发布工件</h5>
          {detail.artifacts.map((a) => (
            <article key={a.id}>
              <button
                disabled={loading}
                onClick={() => void inspectArtifact(a.id)}
              >
                {a.version.fileName} · v{a.version.version} · {a.kind}
              </button>
              <small>
                {' '}
                SHA-256 {a.object.checksum} · {a.object.sizeBytes} bytes
              </small>
            </article>
          ))}
          {!detail.artifacts.length ? (
            <p>此 Run 没有已发布工件。回复内容不自动冒充正式文件。</p>
          ) : null}
          {detail.artifactsTruncated ? <p>仅展示前 50 份工件。</p> : null}
          {artifactId && preview ? (
            <section aria-label="只读交付物预览">
              <ReadOnlyArtifactPreview preview={preview} />
            </section>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
