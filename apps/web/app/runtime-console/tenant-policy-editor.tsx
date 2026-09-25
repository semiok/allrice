'use client';
import { useEffect, useState } from 'react';
import {
  runtimeGovernedActions,
  runtimePolicyActionDecision,
  defaultWorkAutomation,
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
      setNotice(
        '工作区规则已保存。成员的应用和电脑连接可在「连接与用量」查看。',
      );
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
        这里保留工作区的明确禁止规则。日常使用请到前台设置的「员工工作方式」，选择自动执行或每次确认；默认在已授权范围内自动执行。
      </p>
      <p>
        允许不会增加员工工具、文件夹或账号权限。旧的「每次审批」规则按成员工作方式执行；已有审批继续保留。
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
                  const decision = runtimePolicyActionDecision(
                    draft,
                    action,
                    [],
                    defaultWorkAutomation,
                  );
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
                          {effect === 'ask' ? (
                            <option value="ask" disabled>
                              {action === 'assistant.delegate'
                                ? '旧审批规则（不能委派）'
                                : '旧审批规则（跟随成员设置）'}
                            </option>
                          ) : null}
                          <option value="allow">授权范围内允许</option>
                        </select>
                      </td>
                      <td>
                        {decision.effect === 'deny'
                          ? '禁止'
                          : decision.effect === 'ask'
                            ? '需精确审批'
                            : '按成员工作方式执行'}
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
