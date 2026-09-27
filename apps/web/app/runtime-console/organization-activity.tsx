'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ActivityCounts,
  OrganizationActivityOverview,
  OrganizationActivityPeople,
  OrganizationActivityRuns,
} from '@allrice/contracts';
import { TenantValidation } from './tenant-validation';
import styles from './tenant-administration.module.css';

const labels: Record<keyof ActivityCounts, string> = {
  running: '进行中',
  waiting: '等待处理',
  queued: '排队中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
};
async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal }),
    body = await response.json();
  if (!response.ok)
    throw Error(body.error?.message ?? '暂时无法读取工作动态，请重试。');
  return body;
}
// Refresh the loaded pages without clearing the current list or expanded detail.
function usePages<T extends { nextCursor: string | null }>(
  url: string,
  key: keyof T,
  cursorName = 'after',
) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const pages = useRef(1),
    abort = useRef<AbortController | null>(null),
    dataRef = useRef<T | null>(null);
  const load = useCallback(
    async (more = false) => {
      abort.current?.abort();
      const c = new AbortController();
      abort.current = c;
      setLoading(true);
      setError('');
      try {
        let result: T | null = more ? dataRef.current : null,
          cursor = more ? result?.nextCursor : null;
        if (more && !cursor) return;
        for (let i = 0; i < (more ? 1 : pages.current); i++) {
          const value = await read<T>(
            url +
              (cursor ? `&${cursorName}=${encodeURIComponent(cursor)}` : ''),
            c.signal,
          );
          if (c.signal.aborted) return;
          result = result
            ? {
                ...value,
                [key]: [
                  ...(result[key] as unknown[]),
                  ...(value[key] as unknown[]),
                ],
              }
            : value;
          cursor = value.nextCursor;
          if (!cursor) break;
        }
        if (more) pages.current++;
        dataRef.current = result;
        setData(result);
      } catch (e) {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : '读取失败');
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    },
    [url, key, cursorName],
  );
  useEffect(() => {
    pages.current = 1;
    dataRef.current = null;
    setData(null);
    void load();
    return () => abort.current?.abort();
  }, [load]);
  return { data, error, loading, load };
}
function Counts({ counts }: { counts: ActivityCounts }) {
  return (
    <span>
      {Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(
          ([state, count]) =>
            `${labels[state as keyof ActivityCounts]} ${count}`,
        )
        .join(' · ') || '暂无工作'}
    </span>
  );
}
const duration = (ms: number) =>
  `${Math.floor(ms / 60000)} 分 ${Math.floor((ms % 60000) / 1000)} 秒`;

export function OrganizationActivity() {
  const [organizationId, setOrganizationId] = useState(''),
    [userId, setUserId] = useState('');
  const overview = usePages<OrganizationActivityOverview>(
    '/api/v1/admin/activity?view=companies',
    'organizations',
  );
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setOrganizationId(p.get('organizationId') ?? '');
    setUserId(p.get('subjectId') ?? '');
  }, []);
  function choose(org: string, user = '') {
    setOrganizationId(org);
    setUserId(user);
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'activity');
    for (const [key, value] of [
      ['organizationId', org],
      ['subjectId', user],
    ]) {
      if (value) url.searchParams.set(key!, value);
      else url.searchParams.delete(key!);
    }
    window.history.replaceState(null, '', url);
  }
  return (
    <section className={styles.panel} aria-label="工作动态">
      <header>
        <h2>工作动态</h2>
        <p>
          按公司和员工查看正在做的工作、等待原因与交付成果。完成、失败和取消数量统计最近
          7 天。
        </p>
      </header>
      {organizationId ? (
        <>
          <button onClick={() => choose('')}>← 所有公司</button>
          <CompanyActivity
            key={organizationId}
            organizationId={organizationId}
            selectedUserId={userId}
            onUser={(id) => choose(organizationId, id)}
          />
        </>
      ) : (
        <>
          <button
            disabled={overview.loading}
            onClick={() => void overview.load()}
          >
            刷新公司概况
          </button>
          {overview.error && <p role="alert">{overview.error}</p>}
          {!overview.data && overview.loading && (
            <p role="status">正在读取公司…</p>
          )}
          <div className={styles.table}>
            <table>
              <thead>
                <tr>
                  <th>公司</th>
                  <th>员工</th>
                  <th>工作情况</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {overview.data?.organizations.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.name}</strong>
                    </td>
                    <td>{o.peopleCount} 人</td>
                    <td>
                      <Counts counts={o.counts} />
                    </td>
                    <td>
                      <button onClick={() => choose(o.id)}>
                        查看 {o.name}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {overview.data?.nextCursor && (
            <button
              disabled={overview.loading}
              onClick={() => void overview.load(true)}
            >
              更多公司
            </button>
          )}
          {overview.data && !overview.data.organizations.length && (
            <p>还没有公司。可在组织管理中创建。</p>
          )}
        </>
      )}
    </section>
  );
}
function CompanyActivity({
  organizationId,
  selectedUserId,
  onUser,
}: {
  organizationId: string;
  selectedUserId: string;
  onUser: (id: string) => void;
}) {
  const [query, setQuery] = useState(''),
    [attention, setAttention] = useState(false),
    [automatic, setAutomatic] = useState(true);
  const page = usePages<OrganizationActivityPeople>(
    `/api/v1/admin/activity?organizationId=${organizationId}&search=${encodeURIComponent(query)}`,
    'people',
  );
  useEffect(() => {
    if (!automatic) return;
    const timer = setInterval(() => {
      if (!document.hidden) void page.load();
    }, 15000);
    return () => clearInterval(timer);
  }, [automatic, page.load]);
  const people = [...(page.data?.people ?? [])].sort(
    (a, b) =>
      b.counts.running +
      b.counts.waiting +
      b.counts.failed -
      (a.counts.running + a.counts.waiting + a.counts.failed),
  );
  const shown = attention
    ? people.filter(
        (p) =>
          p.counts.running +
            p.counts.waiting +
            p.counts.failed +
            p.counts.queued >
          0,
      )
    : people;
  const selected = people.find((p) => p.userId === selectedUserId);
  return (
    <section aria-label="公司工作动态">
      <h3>{page.data?.organization.name ?? '公司工作动态'}</h3>
      <div className={styles.selectors}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onUser('');
            setQuery(String(new FormData(e.currentTarget).get('search') ?? ''));
          }}
        >
          <label>
            查找员工
            <input
              name="search"
              placeholder="姓名、英文账号或岗位"
              maxLength={160}
            />
          </label>
          <button>查找</button>
        </form>
        <label>
          <input
            type="checkbox"
            checked={attention}
            onChange={(e) => setAttention(e.target.checked)}
          />
          仅看当前列表需要关注的员工
        </label>
        <label>
          <input
            type="checkbox"
            checked={automatic}
            onChange={(e) => setAutomatic(e.target.checked)}
          />
          自动更新
        </label>
        <button disabled={page.loading} onClick={() => void page.load()}>
          刷新工作动态
        </button>
      </div>
      {page.error && <p role="alert">{page.error}</p>}
      {!page.data && page.loading && <p role="status">正在读取员工…</p>}
      <div className={styles.table}>
        <table>
          <thead>
            <tr>
              <th>员工与岗位</th>
              <th>工作情况</th>
              <th>电脑与应用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.userId}>
                <td>
                  <strong>{p.displayName}</strong>
                  <small>
                    {p.jobTitle || '未填写岗位'} · {p.username ?? ''}
                    {p.status === 'disabled' ? ' · 账号已停用' : ''}
                  </small>
                </td>
                <td>
                  <Counts counts={p.counts} />
                </td>
                <td>
                  {p.computerCount} 台电脑 · {p.applicationCount} 个已连接应用
                  {p.lastDeviceSeenAt && (
                    <small>
                      电脑最近心跳：
                      {new Date(p.lastDeviceSeenAt).toLocaleString()}
                    </small>
                  )}
                </td>
                <td>
                  <button
                    aria-pressed={selectedUserId === p.userId}
                    onClick={() => onUser(p.userId)}
                  >
                    查看 {p.displayName} 的工作
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page.data && !shown.length && <p>当前列表没有匹配的员工。</p>}
      {page.data?.nextCursor && (
        <button disabled={page.loading} onClick={() => void page.load(true)}>
          更多员工
        </button>
      )}
      {selectedUserId && (
        <PersonActivity
          key={selectedUserId}
          organizationId={organizationId}
          userId={selectedUserId}
          name={selected?.displayName ?? '所选员工'}
          automatic={automatic}
        />
      )}
    </section>
  );
}
function PersonActivity({
  organizationId,
  userId,
  name,
  automatic,
}: {
  organizationId: string;
  userId: string;
  name: string;
  automatic: boolean;
}) {
  const [employeeId, setEmployee] = useState(''),
    [status, setStatus] = useState('all'),
    [selected, setSelected] = useState<
      OrganizationActivityRuns['runs'][number] | null
    >(null);
  const page = usePages<OrganizationActivityRuns>(
    `/api/v1/admin/activity?organizationId=${organizationId}&userId=${userId}&status=${status}${employeeId ? `&employeeId=${employeeId}` : ''}`,
    'runs',
    'before',
  );
  useEffect(() => {
    if (!automatic) return;
    const timer = setInterval(() => {
      if (!document.hidden) void page.load();
    }, 15000);
    return () => clearInterval(timer);
  }, [automatic, page.load]);
  return (
    <section className={styles.editor} aria-label="员工工作列表">
      <h3>{name} 的工作</h3>
      <div className={styles.selectors}>
        <label>
          AI 员工
          <select
            value={employeeId}
            onChange={(e) => {
              setEmployee(e.target.value);
              setSelected(null);
            }}
          >
            <option value="">全部 AI 员工</option>
            {page.data?.employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          工作状态
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setSelected(null);
            }}
          >
            <option value="all">全部状态</option>
            {Object.entries(labels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button disabled={page.loading} onClick={() => void page.load()}>
          刷新工作列表
        </button>
      </div>
      {page.error && <p role="alert">{page.error}</p>}
      <div className={styles.table}>
        <table>
          <thead>
            <tr>
              <th>工作</th>
              <th>AI 员工</th>
              <th>进展</th>
              <th>耗时</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {page.data?.runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.title}</strong>
                  <small>{new Date(r.createdAt).toLocaleString()}</small>
                </td>
                <td>{r.employeeName}</td>
                <td>
                  {labels[r.status]}
                  <small>{r.stage}</small>
                </td>
                <td>
                  {r.timing ? (
                    <>
                      <span>工作 {duration(r.timing.activeMs)}</span>
                      <small>等待 {duration(r.timing.waitingMs)}</small>
                    </>
                  ) : (
                    '历史任务未记录时钟'
                  )}
                </td>
                <td>
                  <button
                    aria-pressed={selected?.id === r.id}
                    onClick={() => setSelected(r)}
                  >
                    查看工作与成果
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!page.data && page.loading && <p role="status">正在读取工作…</p>}
      {page.data && !page.data.runs.length && <p>还没有匹配的工作。</p>}
      {page.data?.nextCursor && (
        <button disabled={page.loading} onClick={() => void page.load(true)}>
          更早的工作
        </button>
      )}
      {selected && (
        <section aria-label="所选工作">
          <h4>{selected.title}</h4>
          <TenantValidation
            key={selected.id}
            organizationId={organizationId}
            workspaceId={selected.workspaceId}
            subjectId={userId}
            initialRunId={selected.id}
            onDirty={() => undefined}
            onBusy={() => undefined}
          />
        </section>
      )}
    </section>
  );
}
