'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  OrganizationAiDirectorySchema,
  OrganizationPersonAiInstancesSchema,
  contentMaintenanceLabels,
  type OrganizationAiInstance,
  type OrganizationAiPerson,
  type OrganizationDepartment,
  type OrganizationAiDirectoryQuery,
} from '@allrice/contracts';
import { AdminButton } from '../../components/admin/admin-ui';
import { organizationErrorMessage } from './organization-api';
import { useAdminRead as useRead } from './admin-read';
import { loadOrganizationDepartmentOptions } from './organization-departments';
import { EmployeeDetailsDialog } from '../chatflow/employee-details-dialog';
import css from './organization-ai-directory.module.css';

const headers: Record<string, string> = {};

function Counts({ counts }: { counts: OrganizationAiPerson['counts'] }) {
  return (
    <span className={css.counts}>
      <span>通用 {counts.general}</span>
      <span>定制 {counts.custom}</span>
      {counts.inactive > 0 && <span>停用 {counts.inactive}</span>}
      {counts.archived > 0 && <span>已归档 {counts.archived}</span>}
      {counts.pendingAssignments > 0 && (
        <span>配发待建立实例 {counts.pendingAssignments}</span>
      )}
    </span>
  );
}

export function OrganizationAiDirectory({
  organizationId,
  filters = {},
}: {
  organizationId: string;
  filters?: Pick<OrganizationAiDirectoryQuery, 'kind' | 'sourceTemplate'>;
}) {
  const [departments, setDepartments] = useState<OrganizationDepartment[]>([]);
  const [departmentError, setDepartmentError] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const params = new URLSearchParams();
  if (departmentId) params.set('departmentId', departmentId);
  if (search) params.set('search', search);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.sourceTemplate)
    params.set('sourceTemplate', filters.sourceTemplate);
  if (cursors.length) params.set('after', cursors.at(-1)!);
  const { data, error, refresh } = useRead(
    `/api/v1/admin/organizations/${organizationId}/ai-directory?${params}`,
    OrganizationAiDirectorySchema,
  );
  useEffect(() => {
    const controller = new AbortController();
    setDepartmentError('');
    void loadOrganizationDepartmentOptions(organizationId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setDepartments(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setDepartmentError(organizationErrorMessage(error));
      });
    return () => controller.abort();
  }, [organizationId, generation]);
  function resetSelection() {
    setSelected(null);
    setCursors([]);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    setSearch(input.trim());
    resetSelection();
  }
  return (
    <section className={css.view} aria-label="AI 员工与工作沉淀">
      <div className={css.heading}>
        <div>
          <h3>AI 员工与工作沉淀</h3>
          <p>按部门和员工查看实际配发、定制实例与已生效的共享工作内容。</p>
        </div>
        <AdminButton
          onClick={() => {
            resetSelection();
            setGeneration((n) => n + 1);
            refresh();
          }}
        >
          刷新工作沉淀
        </AdminButton>
      </div>
      <form className={css.filters} onSubmit={submit}>
        <label>
          部门
          <select
            aria-label="工作沉淀部门"
            value={departmentId}
            onChange={(event) => {
              setDepartmentId(event.target.value);
              resetSelection();
            }}
          >
            <option value="">全部部门</option>
            <option value="unassigned">未分部门</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
                {department.active ? '' : '（已停用）'}
              </option>
            ))}
          </select>
        </label>
        <label>
          查找员工
          <input
            value={input}
            maxLength={160}
            placeholder="姓名、账号或岗位"
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <AdminButton type="submit">查询</AdminButton>
      </form>
      {departmentError && <p role="alert">部门读取失败：{departmentError}</p>}
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p role="status">正在读取员工与实例…</p>
      ) : (
        <>
          <div className={css.summary} aria-label="当前筛选统计">
            <strong>{data.totals.people} 名员工</strong>
            <Counts counts={data.totals} />
            <small>
              通用与定制仅统计当前可用实例；停用、归档和待建立实例分别列出。
            </small>
          </div>
          <div className={css.layout}>
            <div>
              <div className={css.people} aria-label="真人员工列表">
                {data.people.map((person) => (
                  <button
                    type="button"
                    key={person.userId}
                    aria-pressed={selected === person.userId}
                    aria-label={`查看${person.displayName}的 AI 员工`}
                    onClick={() => setSelected(person.userId)}
                  >
                    <strong>
                      {person.displayName}
                      {!person.active && ' · 已停用'}
                    </strong>
                    <span>
                      {person.departmentName ?? '未分部门'}
                      {person.departmentId && !person.departmentActive
                        ? '（部门已停用）'
                        : ''}
                      {person.jobTitle ? ` · ${person.jobTitle}` : ''}
                    </span>
                    <Counts counts={person.counts} />
                  </button>
                ))}
                {!data.people.length && <p>没有符合条件的员工。</p>}
              </div>
              <div className={css.pagination}>
                <AdminButton
                  disabled={!cursors.length}
                  onClick={() => {
                    setSelected(null);
                    setCursors((c) => c.slice(0, -1));
                  }}
                >
                  上一页
                </AdminButton>
                <span>第 {cursors.length + 1} 页</span>
                <AdminButton
                  disabled={!data.nextCursor}
                  onClick={() => {
                    setSelected(null);
                    setCursors((c) => [...c, data.nextCursor!]);
                  }}
                >
                  下一页
                </AdminButton>
              </div>
            </div>
            {selected &&
            data.people.some((person) => person.userId === selected) ? (
              <PersonInstances
                key={`${organizationId}/${selected}/${generation}/${filters.kind}/${filters.sourceTemplate}`}
                organizationId={organizationId}
                userId={selected}
                filters={filters}
              />
            ) : (
              <p className={css.empty}>
                选择一名员工，查看其通用和定制 AI 员工。
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function PersonInstances({
  organizationId,
  userId,
  filters,
}: {
  organizationId: string;
  userId: string;
  filters: Pick<OrganizationAiDirectoryQuery, 'kind' | 'sourceTemplate'>;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<OrganizationAiInstance | null>(null);
  const view = useMemo(
    () => ({ organizationId, userId }),
    [organizationId, userId],
  );
  const params = new URLSearchParams();
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.sourceTemplate)
    params.set('sourceTemplate', filters.sourceTemplate);
  if (cursors.length) params.set('after', cursors.at(-1)!);
  const { data, error, refresh } = useRead(
    `/api/v1/admin/organizations/${organizationId}/people/${userId}/ai-instances?${params}`,
    OrganizationPersonAiInstancesSchema,
  );
  if (error)
    return (
      <div role="alert">
        {error}
        <AdminButton onClick={refresh}>重新读取</AdminButton>
      </div>
    );
  if (!data) return <p role="status">正在读取 AI 员工…</p>;
  return (
    <section
      className={css.instances}
      aria-label={`${data.person.displayName}的 AI 员工`}
    >
      <header>
        <h4>{data.person.displayName}的 AI 员工</h4>
        <p>
          归属：{data.person.departmentName ?? '未分部门'} · 内容维护级别：
          {contentMaintenanceLabels[data.person.maintenanceLevel]}
        </p>
      </header>
      <p className={css.note}>
        定制实例分别保留；个人名称和调教内容仅本人可见。这里查看已配发基础人设与共享内容。
      </p>
      {data.instances.map((instance) => (
        <article key={instance.id} className={css.instance}>
          <div className={css.instanceHeading}>
            <h5>
              {instance.kind === 'general'
                ? instance.sourceName
                : '定制 AI 员工'}
            </h5>
            <span>
              {
                (
                  {
                    active: '可用',
                    owner_inactive: '员工已停用',
                    assignment_unavailable: '配发已停用',
                    archived: '实例已归档',
                  } as const
                )[instance.state]
              }
            </span>
          </div>
          <p>
            来源：{instance.sourceName} ·{' '}
            {instance.source.kind === 'platform'
              ? `模板 v${instance.source.templateRevision}`
              : '历史配发版本'}
          </p>
          <p>
            维护人：{data.person.displayName} · 实例 v{instance.revision} ·{' '}
            {instance.workspaceName}
          </p>
          <small>
            实例 {instance.id.slice(0, 8)} · 更新{' '}
            {new Date(instance.updatedAt).toLocaleString()}
          </small>
          {instance.sharedSummary && (
            <p>
              共享场景 {instance.sharedSummary.sceneCount} · 资料引用{' '}
              {instance.sharedSummary.referenceCount} · 经验整理按生效策略执行
            </p>
          )}
          <AdminButton
            disabled={instance.state !== 'active'}
            onClick={() => setSelected(instance)}
          >
            查看共享详情
          </AdminButton>
        </article>
      ))}
      {!data.instances.length && (
        <p>
          {data.person.counts.pendingAssignments
            ? '已配发 AI 员工，尚未建立实例记录。'
            : '尚无 AI 员工实例记录。'}
        </p>
      )}
      {(cursors.length > 0 || data.nextCursor) && (
        <div className={css.pagination}>
          <AdminButton
            disabled={!cursors.length}
            onClick={() => {
              setSelected(null);
              setCursors((c) => c.slice(0, -1));
            }}
          >
            上一页实例
          </AdminButton>
          <AdminButton
            disabled={!data.nextCursor}
            onClick={() => {
              setSelected(null);
              setCursors((c) => [...c, data.nextCursor!]);
            }}
          >
            下一页实例
          </AdminButton>
        </div>
      )}
      {selected && (
        <EmployeeDetailsDialog
          open
          scopeId={`organization/${organizationId}/${userId}`}
          instanceId={selected.id}
          employeeId={selected.employeeId}
          workspaceId={selected.workspaceId}
          headers={headers}
          organizationView={view}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
