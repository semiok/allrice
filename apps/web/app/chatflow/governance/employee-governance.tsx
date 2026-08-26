'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import styles from './governance.module.css';

interface QualityEmployee {
  employeeId: string;
  employeeKey: string;
  name: string;
  currentVersionId: string;
  currentVersion: number;
  release: {
    stableVersionId: string;
    candidateVersionId: string | null;
    stage: 'draft' | 'internal_test' | 'canary' | 'production' | 'disabled';
    trafficPercentage: number;
    gateStatus: 'pending' | 'passed' | 'blocked';
  };
  suite: {
    id: string;
    version: number;
    name: string;
    cases: Array<{ key: string; kind: string; critical: boolean }>;
  } | null;
  latestEvaluation: {
    harness: 'codex' | 'dsh';
    provider: string;
    model: string;
    status: 'passed' | 'failed';
    createdAt: string;
  } | null;
  runtimeMetrics: Array<{
    harness: 'codex' | 'dsh';
    provider: string;
    model: string;
    runs: number;
    succeeded: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  }>;
  feedback: { helpful: number; unhelpful: number };
}

interface QualityDashboard {
  organizationId: string;
  workspaceId: string;
  employees: QualityEmployee[];
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    window.location.assign('/login?next=/chatflow/governance');
    throw new Error('登录状态已失效');
  }
  const body = (await response.json().catch(() => null)) as
    T | { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    const code = (body as { error?: { code?: string } } | null)?.error?.code;
    throw new Error(
      code === 'release_gate_blocked'
        ? '关键评测尚未通过，不能扩大流量。'
        : code === 'authorization_denied'
          ? '仅租户管理员可以管理员工发布。'
          : `请求失败（${response.status}）`,
    );
  }
  return body as T;
}

function rate(employee: QualityEmployee) {
  const runs = employee.runtimeMetrics.reduce(
    (sum, item) => sum + item.runs,
    0,
  );
  const succeeded = employee.runtimeMetrics.reduce(
    (sum, item) => sum + item.succeeded,
    0,
  );
  return runs ? Math.round((succeeded / runs) * 100) : null;
}

export function EmployeeGovernance() {
  const [quality, setQuality] = useState<QualityDashboard | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const result = await readJson<{ quality: QualityDashboard }>(
      await fetch('/api/v1/admin/employee-quality', { cache: 'no-store' }),
    );
    setQuality(result.quality);
  }, []);

  useEffect(() => {
    void load().catch((error: unknown) =>
      setNotice(error instanceof Error ? error.message : '发布治理加载失败'),
    );
  }, [load]);

  async function release(
    employee: QualityEmployee,
    action:
      | 'begin_internal_test'
      | 'start_canary'
      | 'promote'
      | 'rollback'
      | 'disable',
  ) {
    if (!quality) return;
    setBusy(employee.employeeId);
    setNotice('');
    try {
      const result = await readJson<{ quality: QualityDashboard }>(
        await fetch('/api/v1/admin/employee-quality', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'update_release',
            payload: {
              workspaceId: quality.workspaceId,
              employeeId: employee.employeeId,
              action,
              candidateVersionId:
                employee.release.candidateVersionId ??
                employee.currentVersionId,
              ...(action === 'start_canary' ? { trafficPercentage: 10 } : {}),
            },
          }),
        }),
      );
      setQuality(result.quality);
      setNotice('发布状态已更新；已有会话继续使用冻结快照。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '发布更新失败');
    } finally {
      setBusy('');
    }
  }

  if (!quality) {
    return (
      <main className={styles.loading}>{notice || '正在加载员工治理…'}</main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href="/chatflow/employees">← 返回员工配置</Link>
          <p>EMPLOYEE QUALITY</p>
          <h1>评测与发布</h1>
          <span>
            内部 revision、门禁和灰度对成员隐藏；关键安全失败会阻断上线。
          </span>
        </div>
        <Link className={styles.chatLink} href="/chatflow">
          与 Rice 工作
        </Link>
      </header>
      {notice ? <div className={styles.notice}>{notice}</div> : null}
      <section className={styles.grid}>
        {quality.employees.map((employee) => {
          const successRate = rate(employee);
          const candidate = employee.release.candidateVersionId;
          return (
            <article key={employee.employeeId}>
              <header>
                <i>{employee.name.slice(0, 1).toUpperCase()}</i>
                <span>
                  <strong>{employee.name}</strong>
                  <small>{employee.employeeKey}</small>
                </span>
                <em data-stage={employee.release.stage}>
                  {employee.release.stage}
                </em>
              </header>
              <div className={styles.metrics}>
                <dl>
                  <dt>生产成功率</dt>
                  <dd>
                    {successRate === null ? '暂无数据' : `${successRate}%`}
                  </dd>
                </dl>
                <dl>
                  <dt>评测门禁</dt>
                  <dd>{employee.release.gateStatus}</dd>
                </dl>
                <dl>
                  <dt>Eval Suite</dt>
                  <dd>
                    v{employee.suite?.version ?? '—'} ·{' '}
                    {employee.suite?.cases.length ?? 0} cases
                  </dd>
                </dl>
                <dl>
                  <dt>用户反馈</dt>
                  <dd>
                    {employee.feedback.helpful} 有用 /{' '}
                    {employee.feedback.unhelpful} 无用
                  </dd>
                </dl>
              </div>
              <section className={styles.eval}>
                <span>最近评测</span>
                {employee.latestEvaluation ? (
                  <strong>
                    {employee.latestEvaluation.status} ·{' '}
                    {employee.latestEvaluation.harness} /{' '}
                    {employee.latestEvaluation.model}
                  </strong>
                ) : (
                  <strong>等待真实 Eval Runner 结果</strong>
                )}
              </section>
              <footer>
                {candidate && employee.release.stage === 'draft' ? (
                  <button
                    disabled={busy === employee.employeeId}
                    onClick={() =>
                      void release(employee, 'begin_internal_test')
                    }
                  >
                    进入内部测试
                  </button>
                ) : null}
                {candidate && employee.release.stage === 'internal_test' ? (
                  <button
                    disabled={busy === employee.employeeId}
                    onClick={() => void release(employee, 'start_canary')}
                  >
                    10% 灰度
                  </button>
                ) : null}
                {candidate && employee.release.stage === 'canary' ? (
                  <button
                    disabled={busy === employee.employeeId}
                    onClick={() => void release(employee, 'promote')}
                  >
                    扩大到生产
                  </button>
                ) : null}
                {candidate ? (
                  <button
                    className={styles.secondary}
                    disabled={busy === employee.employeeId}
                    onClick={() => void release(employee, 'rollback')}
                  >
                    回滚候选
                  </button>
                ) : null}
              </footer>
            </article>
          );
        })}
      </section>
    </main>
  );
}
