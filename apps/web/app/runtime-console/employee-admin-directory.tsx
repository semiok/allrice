'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import {
  PlatformEmployeeHistoryDirectorySchema,
  PlatformEmployeeHistorySchema,
  PlatformEmployeeRevisionSchema,
  UuidSchema,
  type OrganizationAiDirectoryQuery,
} from '@allrice/contracts';
import { AdminButton } from '../../components/admin/admin-ui';
import { OrganizationAiDirectory } from './organization-ai-directory';
import { useAdminRead } from './admin-read';
import { organizationApi, organizationErrorMessage } from './organization-api';
import css from './employee-admin-directory.module.css';

const companyOptions = z
  .object({
    organizations: z.array(z.object({ id: UuidSchema, name: z.string() })),
    nextCursor: UuidSchema.nullable(),
  })
  .transform((value) => ({
    items: value.organizations,
    next: value.nextCursor,
  }));
const templateOptions = PlatformEmployeeHistoryDirectorySchema.transform(
  (value) => ({
    items: value.employees.map((e) => ({
      id: e.id,
      name: `${e.name}${e.status === 'archived' ? '（已归档）' : ''}`,
    })),
    next: value.nextCursor,
  }),
);
type Options = { items: { id: string; name: string }[]; next: string | null };
function useOptions(path: string, schema: { parse(value: unknown): Options }) {
  const [items, setItems] = useState<Options['items']>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [result, setResult] = useState<{
    after: string | null;
    next: string | null;
  }>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void organizationApi(
      `${path}${after ? '?after=' + after : ''}`,
      'GET',
      undefined,
      controller.signal,
    )
      .then(schema.parse)
      .then((value) => {
        if (controller.signal.aborted) return;
        setItems((old) =>
          after
            ? [
                ...old,
                ...value.items.filter((e) => !old.some((v) => v.id === e.id)),
              ]
            : value.items,
        );
        setResult({ after, next: value.next });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(organizationErrorMessage(e));
      });
    return () => controller.abort();
  }, [path, schema, after, retry]);
  return {
    items,
    error,
    loading: result?.after !== after,
    next: result?.after === after ? result.next : null,
    more: () => {
      if (result?.next) setAfter(result.next);
    },
    retry: () => setRetry((n) => n + 1),
  };
}
function OptionsState({
  value,
  label,
}: {
  value: ReturnType<typeof useOptions>;
  label: string;
}) {
  return (
    <>
      {value.error && (
        <p role="alert">
          {value.error}{' '}
          <AdminButton onClick={value.retry}>重新读取{label}</AdminButton>
        </p>
      )}
      {value.next && (
        <AdminButton onClick={value.more} disabled={value.loading}>
          加载更多{label}
        </AdminButton>
      )}
    </>
  );
}

export function EmployeeInstanceDirectory({
  initialSource = '',
}: {
  initialSource?: string;
}) {
  const companies = useOptions('/api/v1/admin/organizations', companyOptions);
  const templates = useOptions(
    '/api/v1/admin/platform-employees/history-directory',
    templateOptions,
  );
  const [company, setCompany] = useState('');
  const [kind, setKind] = useState<'' | 'general' | 'custom'>('');
  const [source, setSource] = useState(initialSource);
  const companyId = company || companies.items[0]?.id || '';
  const filters: Pick<OrganizationAiDirectoryQuery, 'kind' | 'sourceTemplate'> =
    {
      ...(kind ? { kind } : {}),
      ...(source ? { sourceTemplate: source } : {}),
    };
  return (
    <section className={css.section} aria-label="AI 员工实例目录">
      <h2>员工实例</h2>
      <p>
        查看各公司实际配发的通用 AI
        与小白定制实例。来源版本、共享流程和资料沿用组织管理的同一读取规则。
      </p>
      <div className={css.filters}>
        <label>
          公司
          <select
            aria-label="AI 实例公司"
            value={companyId}
            onChange={(e) => setCompany(e.target.value)}
          >
            {!companies.items.length && (
              <option value="">
                {companies.loading ? '正在读取公司…' : '暂无公司'}
              </option>
            )}
            {companies.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          类型
          <select
            aria-label="AI 实例类型"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="">全部实例</option>
            <option value="general">通用 AI 员工</option>
            <option value="custom">小白定制 AI 员工</option>
          </select>
        </label>
        <label>
          来源
          <select
            aria-label="AI 实例来源"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">全部来源</option>
            <option value="legacy">历史配发（无平台模板来源）</option>
            {source &&
              source !== 'legacy' &&
              !templates.items.some((t) => t.id === source) && (
                <option value={source}>当前模板 {source.slice(0, 8)}</option>
              )}
            {templates.items.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <OptionsState value={companies} label="公司" />
      <OptionsState value={templates} label="模板" />
      {companyId && (
        <OrganizationAiDirectory
          key={`${companyId}/${kind}/${source}`}
          organizationId={companyId}
          filters={filters}
        />
      )}
    </section>
  );
}

const revisionResponse = z.object({ revision: PlatformEmployeeRevisionSchema });
const statusLabels = {
  draft: '草稿',
  testing: '测试中',
  published: '已发布',
  disabled: '已停用',
};
function SavedRevision({
  employeeId,
  revisionId,
}: {
  employeeId: string;
  revisionId: string;
}) {
  const { data, error, refresh } = useAdminRead(
    `/api/v1/admin/platform-employees/${employeeId}/revisions/${revisionId}`,
    revisionResponse,
  );
  if (error)
    return (
      <p role="alert">
        {error} <AdminButton onClick={refresh}>重新读取版本</AdminButton>
      </p>
    );
  if (!data) return <p role="status">正在读取保存的版本…</p>;
  const r = data.revision,
    d = r.definition,
    pkg = r.runtimeProfile?.runtimePackage;
  return (
    <article className={css.snapshot} aria-label="模板版本只读详情">
      <h3>
        {d.name} · r{r.revision}
      </h3>
      <p>
        {statusLabels[r.status]} ·{' '}
        {r.publishedAt
          ? '发布时间 ' + new Date(r.publishedAt).toLocaleString()
          : '此版本尚未发布'}
      </p>
      <p>这里只查看已保存的版本；模板编辑、测试和发布在“模板与发布”中进行。</p>
      <dl>
        <dt>版本 ID</dt>
        <dd>{r.id}</dd>
        <dt>配置校验和</dt>
        <dd>{r.checksum}</dd>
        <dt>发布包校验和</dt>
        <dd>{pkg?.checksum ?? '此版本没有已生成的发布包'}</dd>
      </dl>
      <h4>基础与人设</h4>
      <p>{d.description}</p>
      <dl>
        <dt>职责</dt>
        <dd>{d.identity.role}</dd>
        <dt>目标</dt>
        <dd>{d.identity.mission}</dd>
        <dt>工作方式</dt>
        <dd>{d.identity.workStyle}</dd>
      </dl>
      <details>
        <summary>查看保存的执行要求</summary>
        <pre>{d.systemPrompt}</pre>
        <ul>
          {d.identity.behaviorRules.map((rule, index) => (
            <li key={index}>{rule}</li>
          ))}
        </ul>
      </details>
      <h4>该版本的技能与引用</h4>
      {pkg ? (
        <>
          <p>
            技能来自此版本保存的发布包；新任务的默认基础能力仍按实际执行快照核对。
          </p>
          <ul>
            {pkg.skills.map((skill) => (
              <li key={skill.id}>
                {skill.name}
                {skill.bundle ? ` · v${skill.bundle.version}` : ''} ·{' '}
                {skill.checksum}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>此版本没有冻结的发布技能，未用当前技能目录代替历史记录。</p>
      )}
      <p>
        Workflow 引用 {d.capabilities.workflowRevisionIds.length} · Knowledge
        引用 {d.capabilities.knowledgeRevisionIds.length}
      </p>
      {d.capabilities.workflowRevisionIds.length > 0 && (
        <details>
          <summary>Workflow 版本 ID</summary>
          <pre>{d.capabilities.workflowRevisionIds.join('\n')}</pre>
        </details>
      )}
      {d.capabilities.knowledgeRevisionIds.length > 0 && (
        <details>
          <summary>Knowledge 版本 ID</summary>
          <pre>{d.capabilities.knowledgeRevisionIds.join('\n')}</pre>
        </details>
      )}
      <p>公司、部门和个人的工作内容属于使用实例；不加入平台历史模板。</p>
    </article>
  );
}
function RevisionHistory({ employeeId }: { employeeId: string }) {
  const [before, setBefore] = useState<number[]>([]),
    [selected, setSelected] = useState('');
  const { data, error, refresh } = useAdminRead(
    `/api/v1/admin/platform-employees/${employeeId}/revisions${before.length ? '?before=' + before.at(-1) : ''}`,
    PlatformEmployeeHistorySchema,
  );
  if (error)
    return (
      <p role="alert">
        {error} <AdminButton onClick={refresh}>重新读取历史</AdminButton>
      </p>
    );
  if (!data) return <p role="status">正在读取历史版本…</p>;
  const revisionId = data.revisions.some((r) => r.id === selected)
    ? selected
    : data.revisions[0]?.id;
  return (
    <div className={css.history}>
      <div>
        <h3>{data.employee.name} 的保存版本</h3>
        {data.employee.status === 'archived' && (
          <p>模板已归档，仅查看保留的历史。</p>
        )}
        <div className={css.revisions}>
          {data.revisions.map((r) => (
            <button
              type="button"
              key={r.id}
              aria-pressed={revisionId === r.id}
              onClick={() => setSelected(r.id)}
            >
              r{r.revision} · {statusLabels[r.status]}
              <small>{new Date(r.createdAt).toLocaleString()}</small>
            </button>
          ))}
        </div>
        {!data.revisions.length && <p>没有保存的版本。</p>}
        <div className={css.filters}>
          <AdminButton
            disabled={!before.length}
            onClick={() => {
              setSelected('');
              setBefore((old) => old.slice(0, -1));
            }}
          >
            较新版本
          </AdminButton>
          <AdminButton
            disabled={!data.nextBefore}
            onClick={() => {
              setSelected('');
              setBefore((old) => [...old, data.nextBefore!]);
            }}
          >
            更早版本
          </AdminButton>
        </div>
      </div>
      {revisionId && (
        <SavedRevision
          key={`${employeeId}/${revisionId}`}
          employeeId={employeeId}
          revisionId={revisionId}
        />
      )}
    </div>
  );
}
export function EmployeeTemplateHistory({
  initialTemplate = '',
}: {
  initialTemplate?: string;
}) {
  const templates = useOptions(
    '/api/v1/admin/platform-employees/history-directory',
    templateOptions,
  );
  const [selected, setSelected] = useState(initialTemplate);
  const employeeId = selected || templates.items[0]?.id || '';
  return (
    <section className={css.section} aria-label="AI 模板历史">
      <h2>模板历史</h2>
      <p>
        查看保存的配置与发布包，包括已归档模板。查看历史不改变任何员工的配发。
      </p>
      <label className={css.historySelect}>
        来源模板
        <select
          aria-label="历史来源模板"
          value={employeeId}
          onChange={(e) => setSelected(e.target.value)}
        >
          {!employeeId && (
            <option value="">
              {templates.loading ? '正在读取模板…' : '暂无模板'}
            </option>
          )}
          {employeeId && !templates.items.some((t) => t.id === employeeId) && (
            <option value={employeeId}>
              当前模板 {employeeId.slice(0, 8)}
            </option>
          )}
          {templates.items.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <OptionsState value={templates} label="模板" />
      {employeeId && (
        <RevisionHistory key={employeeId} employeeId={employeeId} />
      )}
    </section>
  );
}
