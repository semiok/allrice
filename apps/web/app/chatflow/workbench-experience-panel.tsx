'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  EmployeeDetailsSchema,
  ExperienceDraftBatchSchema,
  type ExperienceDraftBatch,
  type EmployeeDetails,
} from '@allrice/contracts';
import {
  ExperiencePanel,
  ExperienceDraftCard,
} from '../workspace/experience/experience-panel';
import { workbenchJson } from '../../lib/chatflow/workbench-model';
import { WorkbenchIcon } from './workbench-modules';
import css from './workbench-experience-panel.module.css';
const scopes = {
  personal: '个人',
  department: '部门',
  company: '公司',
  platform: '平台',
};
export function WorkbenchExperiencePanel(props: {
  scopeId: string;
  workspaceId: string;
  instanceId?: string;
  employees: Array<{ id: string; name: string }>;
  headers: Record<string, string>;
  active: boolean;
  automatic: boolean;
  onCorrect: (instanceId: string, text: string) => void;
}) {
  const [employee, setEmployee] = useState(props.instanceId ?? 'all'),
    [scope, setScope] = useState('all'),
    [query, setQuery] = useState(''),
    [tab, setTab] = useState<'effective' | 'history'>('effective'),
    [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    details: EmployeeDetails[];
    error: string;
  } | null>(null);
  const selected =
    employee === 'all'
      ? props.employees
      : props.employees.filter((item) => item.id === employee);
  const employeeIds = selected.map((item) => item.id).join(','),
    key = props.scopeId + '/' + employeeIds + '/' + revision;
  useEffect(() => {
    if (!props.active) return;
    const controller = new AbortController();
    void Promise.allSettled(
      employeeIds
        .split(',')
        .filter(Boolean)
        .map((id) =>
          workbenchJson(
            `/api/v1/employee-instances/${id}/content?workspaceId=${props.workspaceId}`,
            props.headers,
            { signal: controller.signal },
          ).then(EmployeeDetailsSchema.parse),
        ),
    ).then((results) => {
      if (controller.signal.aborted) return;
      setSnapshot({
        key,
        details: results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        ),
        error: results.some((result) => result.status === 'rejected')
          ? '部分员工的经验读取失败，可刷新重试。'
          : '',
      });
    });
    return () => controller.abort();
  }, [props.active, props.workspaceId, props.headers, employeeIds, key]);
  const details = snapshot?.key === key ? snapshot.details : [];
  const rows = useMemo(() => {
    const grouped = new Map<
      string,
      {
        source: EmployeeDetails['content']['sources'][number];
        employees: Array<{ id: string; name: string }>;
      }
    >();
    for (const detail of details)
      for (const source of detail.content.sources) {
        if (!source.available || source.reference.sourceKind !== 'experience')
          continue;
        const id =
          source.reference.contentId + '/' + source.reference.revisionId;
        const current = grouped.get(id) ?? { source, employees: [] };
        current.employees.push({
          id: detail.profile.instanceId,
          name: detail.profile.name,
        });
        grouped.set(id, current);
      }
    return [...grouped.values()].filter(
      (row) =>
        (scope === 'all' || row.source.ownership?.scope === scope) &&
        (!query ||
          [
            row.source.title,
            row.source.body,
            ...row.employees.map((e) => e.name),
          ]
            .join('\n')
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())),
    );
  }, [details, scope, query]);
  if (!props.active) return null;
  return (
    <section className={css.panel} aria-label="经验管理">
      <div className={css.toolbar}>
        <select
          aria-label="经验所属员工"
          value={employee}
          onChange={(event) => setEmployee(event.target.value)}
        >
          <option value="all">全部员工</option>
          {props.employees.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <select
          aria-label="经验范围"
          disabled={tab === 'history'}
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="all">全部可见</option>
          <option value="personal">个人经验</option>
          <option value="department">部门经验</option>
          <option value="company">公司经验</option>
          <option value="platform">平台经验</option>
        </select>
        <button type="button" onClick={() => setRevision((n) => n + 1)}>
          刷新
        </button>
      </div>
      <nav className={css.tabs} aria-label="经验视图">
        <button
          type="button"
          aria-pressed={tab === 'effective'}
          onClick={() => setTab('effective')}
        >
          已生效经验
        </button>
        {props.automatic && (
          <button
            type="button"
            aria-pressed={tab === 'history'}
            onClick={() => setTab('history')}
          >
            积累与采用记录
          </button>
        )}
      </nav>
      <div className={css.body}>
        {tab === 'effective' ? (
          <>
            <input
              className={css.search}
              type="search"
              aria-label="查找经验"
              placeholder="查找经验"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {snapshot?.key === key && snapshot.error && (
              <p role="alert">{snapshot.error}</p>
            )}
            {snapshot?.key !== key ? (
              <p role="status">正在读取经验…</p>
            ) : rows.length ? (
              rows.map(({ source, employees }) => (
                <article className={css.card} key={source.reference.revisionId}>
                  <div className={css.cardHeader}>
                    <span className={css.scope}>
                      {source.ownership
                        ? scopes[source.ownership.scope]
                        : '来源不可用'}{' '}
                      · {source.canMaintain ? '可维护' : '只读'}
                    </span>
                    <span>{employees.map((e) => e.name).join('、')}</span>
                  </div>
                  <h3>{source.title ?? '工作经验'}</h3>
                  <p>{source.body ?? '经验正文暂不可用，请刷新。'}</p>
                  <details>
                    <summary>来源与版本</summary>
                    <p>已绑定版本 · {source.reference.revisionId}</p>
                    <small>{source.reference.digest}</small>
                  </details>
                  {source.canMaintain && source.body && (
                    <div className={css.actions}>
                      <button
                        type="button"
                        onClick={() =>
                          props.onCorrect(
                            employees[0]!.id,
                            `请纠正“${source.title ?? source.body}”这条经验：`,
                          )
                        }
                      >
                        在聊天中纠正
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          props.onCorrect(
                            employees[0]!.id,
                            `请忘记“${source.body}”这条${source.ownership?.scope === 'personal' ? '个人' : source.ownership?.scope === 'department' ? '部门' : '公司'}经验。`,
                          )
                        }
                      >
                        在聊天中撤回
                      </button>
                    </div>
                  )}
                </article>
              ))
            ) : props.automatic &&
              (scope === 'all' || scope === 'personal') ? null : (
              <div className={css.empty}>
                <WorkbenchIcon kind="experience" size={38} />
                <p>
                  {query
                    ? '没有匹配的经验。'
                    : '当前范围暂无已绑定的长期经验。'}
                </p>
                <small>
                  可以在聊天中说明需要记住、纠正或忘记什么；自动积累及采用结果在“积累与采用记录”中查看。
                </small>
              </div>
            )}
            {props.automatic && (scope === 'all' || scope === 'personal') && (
              <ActiveExperiences
                key={key}
                workspaceId={props.workspaceId}
                employees={selected}
                headers={props.headers}
                query={query}
              />
            )}
          </>
        ) : (
          selected.map((item) => (
            <section key={item.id} className={css.history}>
              <h3>{item.name}</h3>
              <ExperiencePanel
                key={key + '/' + item.id}
                embedded
                workspaceId={props.workspaceId}
                instanceId={item.id}
                scopeId={props.scopeId}
                headers={props.headers}
              />
            </section>
          ))
        )}
      </div>
    </section>
  );
}

/** Use the existing adoption/provenance response and card; draft rules never
 * appear as active just because their collection batch succeeded. */
function ActiveExperiences(props: {
  workspaceId: string;
  employees: Array<{ id: string; name: string }>;
  headers: Record<string, string>;
  query: string;
}) {
  const ids = props.employees.map((employee) => employee.id).join(',');
  const [snapshot, setSnapshot] = useState<{
    ids: string;
    items: Array<{ employeeId: string; batches: ExperienceDraftBatch[] }>;
    error: boolean;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled(
      ids
        .split(',')
        .filter(Boolean)
        .map(async (employeeId) => {
          const raw = (await workbenchJson(
            '/api/v1/experiences?' +
              new URLSearchParams({
                workspaceId: props.workspaceId,
                instanceId: employeeId,
              }),
            props.headers,
            { signal: controller.signal },
          )) as { draftBatches: unknown[] };
          return {
            employeeId,
            batches: raw.draftBatches.map((value) =>
              ExperienceDraftBatchSchema.parse(value),
            ),
          };
        }),
    ).then((results) => {
      if (!controller.signal.aborted)
        setSnapshot({
          ids,
          items: results.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value] : [],
          ),
          error: results.some((result) => result.status === 'rejected'),
        });
    });
    return () => controller.abort();
  }, [ids, props.workspaceId, props.headers]);
  const items =
    snapshot?.ids === ids
      ? snapshot.items.flatMap((item) =>
          item.batches
            .filter((batch) => batch.sourceState === 'current')
            .flatMap((batch) => {
              const adoptions = batch.adoptions?.filter(
                (adoption) =>
                  adoption.state === 'active' &&
                  (!props.query ||
                    [
                      batch.drafts[adoption.draftIndex]?.rule,
                      batch.drafts[adoption.draftIndex]?.applicability,
                    ]
                      .join('\n')
                      .toLocaleLowerCase()
                      .includes(props.query.toLocaleLowerCase())),
              );
              return adoptions?.length
                ? [{ ...item, batch: { ...batch, adoptions } }]
                : [];
            }),
        )
      : [];
  return (
    <section aria-label="已采用的个人经验">
      {snapshot?.ids !== ids ? (
        <p role="status">正在读取已采用的经验…</p>
      ) : (
        <>
          {snapshot.error && (
            <p role="alert">部分个人经验读取未完成，请刷新重试。</p>
          )}
          {items.map((item) => (
            <section
              key={item.employeeId + '/' + item.batch.id}
              className={css.history}
            >
              <h3>
                {
                  props.employees.find(
                    (employee) => employee.id === item.employeeId,
                  )?.name
                }{' '}
                · 个人经验
              </h3>
              <ExperienceDraftCard
                activeOnly
                batch={item.batch}
                sourceContext={{
                  workspaceId: props.workspaceId,
                  headers: props.headers,
                }}
              />
            </section>
          ))}
          {!items.length && !snapshot.error && (
            <div className={css.empty}>
              <p>暂无符合条件的已采用个人经验。</p>
              <small>
                可以在聊天中说明需要记住、纠正或忘记什么；积累与采用记录保留实际处理结果。
              </small>
            </div>
          )}
        </>
      )}
    </section>
  );
}
