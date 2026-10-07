'use client';
import { useEffect, useState } from 'react';
import { AdminButton as Button } from '../../components/admin/admin-ui';
import type {
  OrganizationActivityPeople,
  OrganizationDashboard,
} from '@allrice/contracts';
import { useActivityPages } from './organization-activity-data';
import { CompanyWorkList } from './company-work-list';
import { CompanyDeliverableLibrary } from './company-deliverables';
import { CompanyAssetsPanel } from './company-assets-panel';
import styles from './admin-data.module.css';
import css from './company-dashboard.module.css';

const dateInput = (date: Date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
const duration = (ms: number | null) =>
  ms === null
    ? '尚无记录'
    : `${(ms / 60000).toLocaleString(undefined, { maximumFractionDigits: 1 })} 分钟`;
export function CompanyDashboard({
  organizationId,
  selectedUserId,
  onUser,
}: {
  organizationId: string;
  selectedUserId: string;
  onUser: (id: string) => void;
}) {
  const [section, setSection] = useState('overview');
  const [employeeId, setEmployeeId] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [rangeChoice, setRangeChoice] = useState('7d');
  const [periodQuery, setPeriodQuery] = useState('range=7d');
  const [from, setFrom] = useState(() =>
    dateInput(new Date(Date.now() - 7 * 86400000)),
  );
  const [to, setTo] = useState(() => dateInput(new Date()));
  const [automatic, setAutomatic] = useState(true);
  const [rangeError, setRangeError] = useState('');
  const [requested, setRequested] = useState({
    status: 'all',
    measure: 'activity',
  });
  const people = useActivityPages<OrganizationActivityPeople>(
    `/api/v1/admin/activity?organizationId=${organizationId}`,
    'people',
  );
  const filters = new URLSearchParams({
    timeZone:
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
  });
  if (selectedUserId) filters.set('userId', selectedUserId);
  if (employeeId) filters.set('employeeId', employeeId);
  if (jobTitle) filters.set('jobTitle', jobTitle);
  const scopeQuery = periodQuery + '&' + filters;
  const url = `/api/v1/admin/activity?view=dashboard&organizationId=${organizationId}&${scopeQuery}`;
  const summary = useActivityPages<OrganizationDashboard>(url);
  const data = summary.data,
    error = rangeError || summary.error,
    loading = summary.loading;
  const current = data
    ? Object.values(data.work.current).reduce((a, b) => a + b, 0)
    : 0;
  useEffect(() => {
    if (!automatic || !current) return;
    const timer = setInterval(() => {
      if (!document.hidden) void summary.load();
    }, 15000);
    return () => clearInterval(timer);
  }, [summary.load, automatic, current]);
  function applyRange(value: string) {
    setRangeChoice(value);
    setRangeError('');
    if (value !== 'custom') setPeriodQuery('range=' + value);
  }
  function show(status: string, measure: string) {
    setRequested({ status, measure });
    setSection('work');
  }
  const work = data?.work;
  const metrics = work
    ? [
        {
          label: '本期发起工作',
          value: work.started,
          status: 'all',
          measure: 'started',
        },
        {
          label: '本期已完成',
          value: work.completed,
          status: 'succeeded',
          measure: 'completed',
        },
        {
          label: '正在处理',
          value: work.current.running,
          status: 'running',
          measure: 'current',
        },
        {
          label: '等待继续',
          value: work.current.waiting,
          status: 'waiting',
          measure: 'current',
        },
        {
          label: '排队中',
          value: work.current.queued,
          status: 'queued',
          measure: 'current',
        },
        {
          label: '本期失败',
          value: work.failed,
          status: 'failed',
          measure: 'completed',
        },
        {
          label: '本期取消',
          value: work.canceled,
          status: 'canceled',
          measure: 'completed',
        },
      ]
    : [];
  return (
    <section className={css.dashboard} aria-label="公司工作概况">
      <h3>{data?.organization.name ?? '工作概况'}</h3>
      <div className={styles.selectors}>
        <label>
          员工
          <select
            aria-label="员工"
            value={selectedUserId}
            onChange={(e) => onUser(e.target.value)}
          >
            <option value="">全公司员工</option>
            {selectedUserId &&
              !people.data?.people.some((p) => p.userId === selectedUserId) && (
                <option value={selectedUserId}>所选员工</option>
              )}
            {people.data?.people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.displayName}
                {p.status === 'disabled' || !p.membershipActive
                  ? ' · 已停用'
                  : ''}
              </option>
            ))}
          </select>
        </label>
        {people.data?.nextCursor && (
          <Button
            disabled={people.loading}
            onClick={() => void people.load(true)}
          >
            更多员工
          </Button>
        )}
        <label>
          AI 员工
          <select
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            <option value="">全部 AI 员工</option>
            {employeeId &&
              !data?.filters.employees.some((e) => e.id === employeeId) && (
                <option value={employeeId}>所选 AI 员工</option>
              )}
            {data?.filters.employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          岗位
          <select
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
          >
            <option value="">全部岗位</option>
            {data?.filters.jobTitles.map((title) => (
              <option key={title} value={title}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <label>
          时间范围
          <select
            value={rangeChoice}
            onChange={(e) => applyRange(e.target.value)}
          >
            <option value="7d">最近 7 天</option>
            <option value="30d">最近 30 天</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        <Button
          icon="refresh"
          variant="quiet"
          disabled={loading}
          onClick={() => void summary.load()}
        >
          刷新工作概况
        </Button>
        <label>
          <input
            type="checkbox"
            checked={automatic}
            onChange={(e) => setAutomatic(e.target.checked)}
          />
          动态工作自动更新
        </label>
      </div>
      {rangeChoice === 'custom' && (
        <form
          className={styles.selectors}
          onSubmit={(e) => {
            e.preventDefault();
            const start = new Date(from),
              end = new Date(to);
            if (!Number.isFinite(start.getTime()) || !(end > start)) {
              setRangeError('请选择有效起止时间。');
              return;
            }
            setRangeError('');
            setPeriodQuery(
              new URLSearchParams({
                range: 'custom',
                from: start.toISOString(),
                to: end.toISOString(),
              }).toString(),
            );
          }}
        >
          <label>
            开始
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              required
            />
          </label>
          <label>
            结束
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
            />
          </label>
          <Button type="submit">应用时间范围</Button>
        </form>
      )}
      <nav className={styles.tabs} role="tablist" aria-label="公司看板内容">
        {(
          [
            ['overview', '概况'],
            ['work', '工作记录'],
            ['deliverables', '交付成果'],
            ['assets', '规矩与范本'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`dashboard-tab-${id}`}
            aria-selected={section === id}
            aria-controls={`dashboard-panel-${id}`}
            tabIndex={section === id ? 0 : -1}
            onKeyDown={(event) => {
              const tabs = Array.from(
                event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                ),
              );
              const index = tabs.indexOf(event.currentTarget);
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : null;
              if (next === null) return;
              const target = tabs[next];
              if (!target) return;
              event.preventDefault();
              target.click();
              target.focus();
            }}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      {!data && loading && <p role="status">正在读取公司概况…</p>}
      <div
        role="tabpanel"
        id="dashboard-panel-overview"
        aria-labelledby="dashboard-tab-overview"
        hidden={section !== 'overview'}
      >
        {data && (
          <>
            <p className={css.caption}>
              {new Date(data.period.from).toLocaleString()} —{' '}
              {new Date(data.period.to).toLocaleString()} ·{' '}
              {data.period.timeZone} · 最近更新{' '}
              {new Date(data.updatedAt).toLocaleTimeString()}
            </p>
            <div className={css.people}>
              <span>
                可用员工 <strong>{data.people.activeEmployees}</strong>
              </span>
              <span>
                已配发 AI <strong>{data.people.assignedEmployees}</strong>
              </span>
              <span>
                本期活跃 <strong>{data.people.activeParticipants}</strong>
              </span>
              <span>
                已停用 / 离职 <strong>{data.people.inactiveEmployees}</strong>
              </span>
              <span>
                配发覆盖{' '}
                {data.people.activeEmployees
                  ? `${Math.round((data.people.assignedEmployees / data.people.activeEmployees) * 100)}%`
                  : '暂无可统计员工'}
              </span>
              {data.people.historicalParticipants > 0 && (
                <span>
                  历史参与员工 {data.people.historicalParticipants} 人
                </span>
              )}
            </div>
            {data.investmentEvidence && (
              <section
                className={css.investment}
                aria-label="投入与收益（估算）"
              >
                <h4>投入与收益（估算）</h4>
                <p>节省工时与收益：尚无估算依据</p>
                <p className={css.caption}>
                  需要人工处理基准、明确采用的成果及实际人工投入。费用币种与完整投入尚未确认。
                </p>
                <div className={css.facts}>
                  <section>
                    <h4>已记录 AI 耗时</h4>
                    <p>
                      工作 {duration(data.investmentEvidence.recordedActiveMs)}{' '}
                      · 等待{' '}
                      {duration(data.investmentEvidence.recordedWaitingMs)}
                    </p>
                    <small>
                      本期 {data.investmentEvidence.terminalRuns} 项终态工作中，
                      {data.investmentEvidence.runsWithClock} 项有耗时记录。
                      这是 AI
                      耗时，不等于人工投入或节省工时；未记录部分不计为零。
                    </small>
                  </section>
                  <section>
                    <h4>公司范本使用事实</h4>
                    <p>
                      选用 {data.investmentEvidence.templateSelectedRuns} 项工作
                      · 已装载 {data.investmentEvidence.templateLoadedRuns} 项 ·
                      有读取回执 {data.investmentEvidence.templateReadRuns} 项
                    </p>
                    <small>
                      {data.investmentEvidence.templateDeliveredRuns}{' '}
                      项工作已有可用的来源成果。
                      同一主任务只计一次；读取或生成不代表业务已采用，也不直接折算收益。
                    </small>
                  </section>
                </div>
              </section>
            )}
            <div className={css.metrics}>
              {metrics.map((m) => (
                <Button
                  key={m.label}
                  className={css.metric}
                  variant="quiet"
                  onClick={() => show(m.status, m.measure)}
                >
                  <span>{m.label}</span>
                  <strong>{m.value.toLocaleString()}</strong>
                  <small>查看工作</small>
                </Button>
              ))}
            </div>
            <p className={css.caption}>
              发起按开始时间，完成、失败和取消按结束时间；正在处理、等待和排队显示当前状态。归档会话仍计入历史。
            </p>
            <div className={css.facts}>
              <section>
                <h4>交付成果</h4>
                <p>
                  当前可用成果 {data.deliverables.availableSeries} 项 ·
                  本期首次交付 {data.deliverables.firstDeliveries} 项 · 本期修订{' '}
                  {data.deliverables.revisedSeries} 项
                </p>
                <small>
                  按成果系列去重，版本修改另列；工具日志、分页结果和附件上传不计为交付。
                </small>
              </section>
              <section>
                <h4>已记录模型用量</h4>
                <p>
                  {data.usage.inputTokens === null &&
                  data.usage.outputTokens === null
                    ? '暂无可确认用量，不代表没有消耗'
                    : data.usage.inputTokens === null ||
                        data.usage.outputTokens === null
                      ? `已确认部分：输入 ${data.usage.inputTokens?.toLocaleString() ?? '待补全'}，输出 ${data.usage.outputTokens?.toLocaleString() ?? '待补全'} Token；总量待补全`
                      : `${(data.usage.inputTokens + data.usage.outputTokens).toLocaleString()} Token${data.usage.incompleteReceipts ? '（已确认部分）' : ''}`}
                </p>
                <small>
                  本期有 {data.usage.receiptCount} 条回执；
                  {data.usage.terminalRuns} 项终态工作中，
                  {data.usage.terminalRunsWithReceipts}{' '}
                  项已有用量回执。缓存已包含在输入中。
                </small>
                <p>费用尚无完整账单</p>
                <small>
                  已计价回执 {data.usage.pricedReceipts} 条 · 订阅回执{' '}
                  {data.usage.subscriptionReceipts} 条 · 待计价{' '}
                  {data.usage.unknownCostReceipts} 条。订阅用量不按 API
                  单价重算，未确认费用不显示为零。
                </small>
              </section>
            </div>
          </>
        )}
      </div>
      <div
        role="tabpanel"
        id="dashboard-panel-work"
        aria-labelledby="dashboard-tab-work"
        hidden={section !== 'work'}
      >
        <CompanyWorkList
          organizationId={organizationId}
          userId={selectedUserId || null}
          name={
            people.data?.people.find((p) => p.userId === selectedUserId)
              ?.displayName ?? '全公司'
          }
          scopeQuery={scopeQuery}
          automatic={automatic && current > 0}
          requested={requested}
        />
      </div>
      <div
        role="tabpanel"
        id="dashboard-panel-deliverables"
        aria-labelledby="dashboard-tab-deliverables"
        hidden={section !== 'deliverables'}
      >
        <CompanyDeliverableLibrary
          organizationId={organizationId}
          scopeQuery={scopeQuery}
        />
      </div>
      <div
        role="tabpanel"
        id="dashboard-panel-assets"
        aria-labelledby="dashboard-tab-assets"
        hidden={section !== 'assets'}
      >
        <CompanyAssetsPanel
          key={organizationId}
          organizationId={organizationId}
        />
      </div>
    </section>
  );
}
