'use client';
import { useEffect, useState } from 'react';
import {
  runtimeGovernedActions,
  runtimePolicyActionDecision,
  type RuntimePolicyControls,
} from '@allrice/contracts';
import styles from './tenant-administration.module.css';
type Snapshot = {
  organizationId: string;
  workspaceId: string;
  version: number | null;
  controls: RuntimePolicyControls | null;
};
const empty = (): RuntimePolicyControls => ({
  version: 1,
  enabled: false,
  mode: 'execute',
  rules: [],
});
export function TenantPolicyEditor({
  organizationId,
  workspaceId,
  onDirty,
  onBusy,
}: {
  organizationId: string;
  workspaceId: string;
  onDirty: (v: boolean) => void;
  onBusy: (v: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [draft, setDraft] = useState<RuntimePolicyControls>(empty);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    setLoading(true);
    setError('');
    fetch(
      `/api/v1/admin/tenants/${organizationId}/policy?workspaceId=${workspaceId}`,
      { cache: 'no-store', signal: controller.signal },
    )
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw Error(result.error?.message ?? '策略读取失败');
        return result as Snapshot;
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (
          result.organizationId !== organizationId ||
          result.workspaceId !== workspaceId
        )
          throw Error('策略范围不匹配');
        setSnapshot(result);
        setDraft(result.controls ?? empty());
        setReason('');
        onDirty(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : '策略读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [organizationId, workspaceId, refresh, onDirty]);
  const change = (value: RuntimePolicyControls) => {
    setDraft(value);
    onDirty(true);
    setNotice('');
  };
  async function save() {
    if (!snapshot || busy) return;
    setBusy(true);
    onBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(
        `/api/v1/admin/tenants/${organizationId}/policy`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            expectedVersion: snapshot.version,
            controls: { ...draft, version: (snapshot.version ?? 0) + 1 },
            reason,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error?.message ?? '保存未确认，请刷新核对');
      setNotice('策略已保存并审计；未开启平台执行开关，也未授予设备权限。');
      setRefresh((value) => value + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存未确认');
      setSnapshot(null);
      onDirty(false);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <section aria-label="执行策略">
      <h3>执行策略</h3>
      <p>
        策略控制当前工作区的执行动作，不等于员工工具清单。平台开关、执行环境、实际使用者权限仍独立校验；禁止不会被员工配置覆盖。
      </p>
      <p>
        Changeset：workspace.export.create 生成提案 → 网页精确审批 →
        local.fs.changeset 落盘；后者是内部执行动作，不是新增模型工具。
      </p>
      <button
        disabled={busy || loading}
        onClick={() => {
          if (
            !snapshot ||
            window.confirm('重新读取将放弃未保存的策略修改，是否继续？')
          )
            setRefresh((v) => v + 1);
        }}
      >
        重新读取策略
      </button>
      {loading ? <p role="status">读取策略…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {snapshot ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p>
            当前版本：{snapshot.version ?? '未配置'} · 保存将创建版本{' '}
            {(snapshot.version ?? 0) + 1}
          </p>
          <div className={styles.selectors}>
            <label>
              <input
                type="checkbox"
                aria-label="启用工作区策略"
                checked={draft.enabled}
                disabled={busy}
                onChange={(e) =>
                  change({ ...draft, enabled: e.target.checked })
                }
              />
              启用工作区策略
            </label>
            <label>
              执行模式
              <select
                aria-label="策略执行模式"
                value={draft.mode}
                disabled={busy}
                onChange={(e) =>
                  change({
                    ...draft,
                    mode: e.target.value as RuntimePolicyControls['mode'],
                  })
                }
              >
                <option value="execute">按动作规则执行</option>
                <option value="plan_only">仅规划（读操作仍按规则）</option>
              </select>
            </label>
          </div>
          <div className={styles.table}>
            <table>
              <thead>
                <tr>
                  <th>动作</th>
                  <th>配置</th>
                  <th>该策略的判定</th>
                </tr>
              </thead>
              <tbody>
                {runtimeGovernedActions.map((action) => {
                  const matches = draft.rules.filter(
                    (rule) => rule.action === action,
                  );
                  const effect = matches.some((r) => r.effect === 'deny')
                    ? 'deny'
                    : matches.some((r) => r.effect === 'ask')
                      ? 'ask'
                      : matches.some((r) => r.effect === 'allow')
                        ? 'allow'
                        : 'unset';
                  const forced =
                    runtimePolicyActionDecision(
                      {
                        version: 1,
                        enabled: true,
                        mode: 'execute',
                        rules: [{ action, effect: 'allow' }],
                      },
                      action,
                    ).effect === 'ask';
                  const decision = runtimePolicyActionDecision(draft, action);
                  return (
                    <tr key={action}>
                      <td>
                        <code>{action}</code>
                      </td>
                      <td>
                        <select
                          aria-label={`${action} 规则`}
                          disabled={busy}
                          value={effect}
                          onChange={(e) =>
                            change({
                              ...draft,
                              rules: [
                                ...draft.rules.filter(
                                  (rule) => rule.action !== action,
                                ),
                                ...(e.target.value === 'unset'
                                  ? []
                                  : [
                                      {
                                        action,
                                        effect: e.target.value as
                                          'deny' | 'ask' | 'allow',
                                      },
                                    ]),
                              ],
                            })
                          }
                        >
                          <option value="unset">未配置（禁止）</option>
                          <option value="deny">禁止</option>
                          <option value="ask">每次审批</option>
                          <option value="allow">
                            {forced
                              ? '允许申请（仍每次审批）'
                              : '授权范围内允许'}
                          </option>
                        </select>
                      </td>
                      <td>
                        {decision.effect === 'deny'
                          ? '禁止'
                          : decision.effect === 'ask'
                            ? '需精确审批'
                            : '允许'}
                        <small>{decision.reason}</small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <details>
            <summary>核对修改前后</summary>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {JSON.stringify(
                {
                  before: snapshot.controls,
                  after: { ...draft, version: (snapshot.version ?? 0) + 1 },
                },
                null,
                2,
              )}
            </pre>
          </details>
          <label>
            修改原因
            <textarea
              aria-label="策略修改原因"
              value={reason}
              disabled={busy}
              minLength={5}
              maxLength={500}
              required
              onChange={(e) => {
                setReason(e.target.value);
                onDirty(true);
              }}
            />
          </label>
          <button disabled={busy || reason.trim().length < 5}>
            {busy ? '保存中…' : '确认保存策略'}
          </button>
        </form>
      ) : null}
    </section>
  );
}
