'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  OrganizationImportSchema,
  type ManagedOrganization,
  type OrganizationPerson,
  type OrganizationAiTarget,
} from '@allrice/contracts';
import { OrganizationAiAssignments } from './organization-ai-assignments';
import { TenantResourceEditor } from './tenant-resource-editor';
import styles from './tenant-administration.module.css';

const messages: Record<string, string> = {
  AUTHENTICATION_REQUIRED: '登录已过期，请重新登录。',
  AUTHORIZATION_DENIED: '需要平台管理员账号。',
  NOT_FOUND: '公司或员工已不存在，请刷新。',
  INVALID_REQUEST: '请检查姓名、英文账号格式和密码长度。',
  account_conflict: '员工信息已被其他操作修改，请刷新后重试。',
  organization_conflict: '公司信息已更新，请刷新后重试。',
  username_taken: '英文账号已被使用，请换一个昵称；现有账号的密码不会被覆盖。',
  email_taken: '邮箱已关联其他账号。',
  reserved_username: '这个账号名称用于平台管理，请换一个英文昵称。',
};
export async function organizationApi<T>(
  url: string,
  method = 'GET',
  input?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method,
    cache: 'no-store',
    signal,
    ...(input
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
      : {}),
  });
  const body = await response.json();
  if (!response.ok)
    throw Error(messages[body.code] ?? '请求未完成，请刷新核对后重试。');
  return body as T;
}
const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : '暂时无法连接，请重试。';

export function OrganizationAdministration() {
  const [organizations, setOrganizations] = useState<ManagedOrganization[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [savingCompany, setBusy] = useState(false);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [configurationBusy, setConfigurationBusy] = useState(false);
  const busy = savingCompany || peopleBusy || configurationBusy;
  const [editor, setEditor] = useState<'create' | 'edit' | null>(null);
  const controller = useRef<AbortController | null>(null);
  const selection = useRef('');
  selection.current = selectedId;
  const selected = organizations.find((o) => o.id === selectedId);
  const load = useCallback(async (after?: string, selected?: string) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError('');
    try {
      const result = await organizationApi<{
        organizations: ManagedOrganization[];
        nextCursor: string | null;
      }>(
        `/api/v1/admin/organizations${after ? `?after=${after}` : ''}`,
        'GET',
        undefined,
        request.signal,
      );
      const wanted =
        selected ||
        selection.current ||
        new URLSearchParams(window.location.search).get('organizationId');
      if (
        !after &&
        wanted &&
        !result.organizations.some((o) => o.id === wanted)
      ) {
        const detail = await organizationApi<{
          organization: ManagedOrganization;
        }>(
          `/api/v1/admin/organizations/${wanted}`,
          'GET',
          undefined,
          request.signal,
        );
        result.organizations.unshift(detail.organization);
      }
      if (request.signal.aborted) return;
      setOrganizations((old) =>
        after
          ? [
              ...old,
              ...result.organizations.filter(
                (o) => !old.some((x) => x.id === o.id),
              ),
            ]
          : result.organizations,
      );
      setNext(result.nextCursor);
      setSelectedId(
        (old) => selected || old || wanted || result.organizations[0]?.id || '',
      );
    } catch (e) {
      if (!request.signal.aborted) setError(errorMessage(e));
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);
  async function saveCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const result = await organizationApi<{ organizationId?: string }>(
        '/api/v1/admin/organizations' +
          (editor === 'edit' ? `/${selected!.id}` : ''),
        editor === 'edit' ? 'PATCH' : 'POST',
        {
          name: data.get('name'),
          businessContext: data.get('businessContext'),
          ...(editor === 'edit'
            ? { expectedRevision: selected!.revision }
            : {}),
        },
      );
      setEditor(null);
      await load(undefined, result.organizationId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.panel} aria-label="组织管理">
      <header>
        <h2>组织管理</h2>
        <p>按公司管理员工账号、岗位职能与 AI 员工。</p>
      </header>
      <div className={styles.selectors}>
        <label>
          公司
          <select
            aria-label="管理公司"
            value={selectedId}
            disabled={busy || !!editor}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            <option value="">选择公司</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} · {o.peopleCount} 人
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy || !!editor} onClick={() => setEditor('create')}>
          新建公司
        </button>
        <button
          disabled={busy || loading || !!editor}
          onClick={() => void load()}
        >
          刷新
        </button>
        {next && (
          <button
            disabled={loading || busy || !!editor}
            onClick={() => void load(next)}
          >
            更多公司
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">正在读取公司…</p>}
      {editor && (
        <form key={editor} className={styles.editor} onSubmit={saveCompany}>
          <h3>{editor === 'create' ? '新建公司' : '编辑公司'}</h3>
          <fieldset disabled={busy}>
            <label>
              公司名称
              <input
                name="name"
                required
                maxLength={160}
                defaultValue={editor === 'edit' ? selected?.name : ''}
              />
            </label>
            <label>
              公司业务背景
              <textarea
                name="businessContext"
                maxLength={8000}
                defaultValue={
                  editor === 'edit' ? selected?.businessContext : ''
                }
                placeholder="例如主营业务、客户群体和团队工作习惯"
              />
            </label>
            <div className={styles.selectors}>
              <button>{busy ? '保存中…' : '保存公司'}</button>
              <button type="button" onClick={() => setEditor(null)}>
                取消
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {selected && (
        <>
          <div className={styles.selectors}>
            <h3>{selected.name}</h3>
            <button
              disabled={busy || !!editor}
              onClick={() => setEditor('edit')}
            >
              编辑公司
            </button>
          </div>
          <OrganizationPeople
            key={selected.id}
            organization={selected}
            onBusy={setPeopleBusy}
            onChanged={() => void load()}
          />
          <CompanyConfiguration
            key={`config-${selected.id}`}
            organization={selected}
            onBusy={setConfigurationBusy}
          />
        </>
      )}
      {!selected && !loading && !editor && (
        <p>新建公司后，即可添加员工。所有员工从 allrice.bplabs.xyz 登录。</p>
      )}
    </section>
  );
}

export function OrganizationPeople({
  organization,
  onBusy,
  onChanged,
}: {
  organization: ManagedOrganization;
  onBusy: (busy: boolean) => void;
  onChanged: () => void;
}) {
  const [people, setPeople] = useState<OrganizationPerson[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<
    'new' | 'bulk' | OrganizationPerson | null
  >(null);
  const [reset, setReset] = useState<OrganizationPerson | null>(null);
  const [selectedPeople, setSelectedPeople] = useState<string[]>([]);
  const [aiTarget, setAiTarget] = useState<{
    target: OrganizationAiTarget;
    title: string;
  } | null>(null);
  const editing = !!editor || !!reset || !!aiTarget;
  const controller = useRef<AbortController | null>(null);
  const base = `/api/v1/admin/organizations/${organization.id}/people`;
  const load = useCallback(
    async (after?: string) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setLoading(true);
      setError('');
      const params = new URLSearchParams({ search: query });
      if (after) params.set('after', after);
      try {
        const result = await organizationApi<{
          people: OrganizationPerson[];
          nextCursor: string | null;
        }>(`${base}?${params}`, 'GET', undefined, request.signal);
        if (request.signal.aborted) return;
        setPeople((old) =>
          after
            ? [
                ...old,
                ...result.people.filter(
                  (p) => !old.some((o) => o.userId === p.userId),
                ),
              ]
            : result.people,
        );
        setNext(result.nextCursor);
      } catch (e) {
        if (!request.signal.aborted) setError(errorMessage(e));
      } finally {
        if (!request.signal.aborted) setLoading(false);
      }
    },
    [base, query],
  );
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);
  async function mutate(
    url: string,
    method: string,
    input: unknown,
    message: string,
  ) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await organizationApi(url, method, input);
      setEditor(null);
      setReset(null);
      setNotice(message);
      await load();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    onBusy(busy || editing);
    return () => onBusy(false);
  }, [busy, editing, onBusy]);
  function savePerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = {
      username: data.get('username'),
      displayName: data.get('displayName'),
      jobTitle: data.get('jobTitle'),
      responsibilities: data.get('responsibilities'),
    };
    const edited = typeof editor === 'object' ? editor : null;
    void mutate(
      edited ? `${base}/${edited.userId}` : base,
      edited ? 'PATCH' : 'POST',
      edited
        ? { ...input, expectedVersion: edited.version }
        : {
            people: [
              { ...input, password: data.get('password') || 'admin@321' },
            ],
          },
      edited ? '员工资料已保存。' : '员工账号已创建，可直接登录统一工作台。',
    );
  }
  const edited = typeof editor === 'object' ? editor : null;
  return (
    <section aria-label="公司员工">
      <div className={styles.selectors}>
        <h3>员工账号</h3>
        <button disabled={busy || editing} onClick={() => setEditor('new')}>
          添加员工
        </button>
        <button disabled={busy || editing} onClick={() => setEditor('bulk')}>
          批量导入
        </button>
        <button
          disabled={busy || loading || editing}
          onClick={() => void load()}
        >
          刷新员工
        </button>
        <form
          className={styles.accountSearch}
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(String(new FormData(e.currentTarget).get('search') ?? ''));
            setSelectedPeople([]);
          }}
        >
          <label>
            查找员工
            <input
              name="search"
              placeholder="姓名、英文账号或岗位"
              maxLength={160}
              disabled={busy || editing}
            />
          </label>
          <button disabled={busy || editing}>查找</button>
        </form>
      </div>
      <p>
        所有员工均使用普通员工权限。初始密码为
        admin@321，可由管理员指定或由员工登录后修改。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">正在读取员工…</p>}
      <div className={styles.selectors}>
        <button
          disabled={busy || editing || !selectedPeople.length}
          onClick={() =>
            setAiTarget({
              target: { type: 'selected', userIds: selectedPeople },
              title: `已选 ${selectedPeople.length} 人的 AI 员工`,
            })
          }
        >
          配置已选员工的 AI · {selectedPeople.length}
        </button>
        <button
          disabled={busy || editing || !query.trim()}
          onClick={() =>
            setAiTarget({
              target: { type: 'search', search: query },
              title: `符合「${query}」的员工`,
            })
          }
        >
          配置筛选结果的 AI
        </button>
        <button
          disabled={busy || editing}
          onClick={() =>
            setAiTarget({
              target: { type: 'all' },
              title: '全公司员工的 AI 配发',
            })
          }
        >
          配置全公司员工的 AI
        </button>
      </div>
      {aiTarget && (
        <OrganizationAiAssignments
          organization={organization}
          target={aiTarget.target}
          title={aiTarget.title}
          onClose={() => setAiTarget(null)}
        />
      )}
      {editor === 'bulk' ? (
        <BulkPeopleImport
          busy={busy}
          onCancel={() => {
            setEditor(null);
            setError('');
          }}
          onSave={(people) =>
            void mutate(
              base,
              'POST',
              { people },
              `已创建 ${people.length} 个员工账号。`,
            )
          }
        />
      ) : (
        editor && (
          <form
            key={edited?.userId ?? 'new'}
            className={styles.editor}
            onSubmit={savePerson}
          >
            <h3>{edited ? '编辑员工' : '添加员工'}</h3>
            <fieldset disabled={busy}>
              <label>
                英文账号
                <input
                  name="username"
                  required
                  pattern="[a-zA-Z][a-zA-Z0-9._-]*"
                  minLength={2}
                  maxLength={64}
                  autoComplete="off"
                  defaultValue={edited?.username ?? ''}
                />
              </label>
              <label>
                姓名
                <input
                  name="displayName"
                  required
                  maxLength={120}
                  defaultValue={edited?.displayName ?? ''}
                />
              </label>
              <label>
                岗位
                <input
                  name="jobTitle"
                  maxLength={160}
                  defaultValue={edited?.jobTitle ?? ''}
                />
              </label>
              <label>
                职能
                <textarea
                  name="responsibilities"
                  maxLength={8000}
                  defaultValue={edited?.responsibilities ?? ''}
                />
              </label>
              {!edited && (
                <label>
                  初始密码
                  <input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={256}
                    defaultValue="admin@321"
                    required
                  />
                </label>
              )}
              <div className={styles.selectors}>
                <button>{busy ? '保存中…' : '保存员工'}</button>
                <button type="button" onClick={() => setEditor(null)}>
                  取消
                </button>
              </div>
            </fieldset>
          </form>
        )
      )}
      {reset && (
        <form
          className={styles.editor}
          onSubmit={(e) => {
            e.preventDefault();
            void mutate(
              `${base}/${reset.userId}/password`,
              'POST',
              { password: new FormData(e.currentTarget).get('password') },
              '密码已重置，旧登录已退出。',
            );
          }}
        >
          <h3>重置 {reset.displayName} 的密码</h3>
          <fieldset disabled={busy}>
            <label>
              新密码
              <input
                name="password"
                type="password"
                minLength={8}
                maxLength={256}
                required
                autoComplete="new-password"
                defaultValue="admin@321"
              />
            </label>
            <div className={styles.selectors}>
              <button>重置密码</button>
              <button type="button" onClick={() => setReset(null)}>
                取消
              </button>
            </div>
          </fieldset>
        </form>
      )}
      <div className={styles.table}>
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="选择当前列表员工"
                  disabled={busy || editing || !people.length}
                  checked={
                    people.length > 0 &&
                    people.every((p) => selectedPeople.includes(p.userId))
                  }
                  onChange={(e) =>
                    setSelectedPeople(
                      e.target.checked ? people.map((p) => p.userId) : [],
                    )
                  }
                />
              </th>
              <th>员工</th>
              <th>岗位与职能</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.userId}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${p.displayName}`}
                    checked={selectedPeople.includes(p.userId)}
                    disabled={busy || editing}
                    onChange={(e) =>
                      setSelectedPeople((old) =>
                        e.target.checked
                          ? [...old, p.userId]
                          : old.filter((id) => id !== p.userId),
                      )
                    }
                  />
                </td>
                <td>
                  <strong>{p.displayName}</strong>
                  <small>{p.username ?? '待迁移英文账号'}</small>
                </td>
                <td>
                  {p.jobTitle || '未填写岗位'}
                  <small>{p.responsibilities}</small>
                </td>
                <td>
                  {p.status === 'disabled'
                    ? '已停用'
                    : !p.membershipActive
                      ? '公司访问已撤回'
                      : p.status === 'invited'
                        ? '待激活'
                        : '可登录'}
                </td>
                <td>
                  <div className={styles.selectors}>
                    <button
                      disabled={busy || editing}
                      onClick={() =>
                        setAiTarget({
                          target: { type: 'selected', userIds: [p.userId] },
                          title: `${p.displayName} 的 AI 员工`,
                        })
                      }
                    >
                      AI 员工
                    </button>
                    <button
                      disabled={busy || editing}
                      onClick={() => setEditor(p)}
                    >
                      编辑
                    </button>
                    <button
                      disabled={busy || editing}
                      onClick={() => setReset(p)}
                    >
                      重置密码
                    </button>
                    <button
                      disabled={busy || editing}
                      onClick={() =>
                        void mutate(
                          `${base}/${p.userId}/status`,
                          'POST',
                          {
                            active: p.status === 'disabled',
                            expectedVersion: p.version,
                          },
                          p.status === 'disabled'
                            ? '账号已启用。'
                            : '账号已停用，历史工作和文件已保留。',
                        )
                      }
                    >
                      {p.status === 'disabled' ? '启用账号' : '停用账号'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !people.length && (
        <p>没有匹配的员工。可以添加员工或从表格批量导入。</p>
      )}
      {next && (
        <button
          disabled={busy || loading || editing}
          onClick={() => void load(next)}
        >
          更多员工
        </button>
      )}
    </section>
  );
}

function BulkPeopleImport({
  busy,
  onCancel,
  onSave,
}: {
  busy: boolean;
  onCancel: () => void;
  onSave: (
    people: {
      username: string;
      displayName: string;
      jobTitle: string;
      responsibilities: string;
      password: string;
    }[],
  ) => void;
}) {
  const [value, setValue] = useState('');
  const parsed = useMemo(() => {
    const lines = value.split(/\r?\n/).filter((line) => line.trim());
    if (lines[0]?.startsWith('英文账号\t')) lines.shift();
    if (lines.some((line) => line.split('\t').length > 4)) return null;
    const result = OrganizationImportSchema.safeParse({
      people: lines.map((line) => {
        const [username, displayName, jobTitle = '', responsibilities = ''] =
          line.split('\t');
        return { username, displayName, jobTitle, responsibilities };
      }),
    });
    return result.success ? result.data.people : null;
  }, [value]);
  return (
    <form
      className={styles.editor}
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed) onSave(parsed);
      }}
    >
      <h3>批量导入员工</h3>
      <p>
        从 Excel
        复制「英文账号、姓名、岗位、职能」四列粘贴到下方，每行一人，最多 100
        人。初始密码统一为 admin@321。
      </p>
      <fieldset disabled={busy}>
        <label>
          员工表格
          <textarea
            aria-label="员工表格"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              'snow\t小雪\t财务\t供应商对账\ndrink\t小李\t运营\t内容与活动'
            }
          />
        </label>
        {parsed ? (
          <p role="status">
            将创建 {parsed.length} 人：
            {parsed.map((p) => p.displayName).join('、')}。
          </p>
        ) : (
          value && (
            <p role="alert">
              请检查四列格式、重复账号和必填的英文账号/姓名。单个单元格请勿换行。
            </p>
          )
        )}
        <p>账号重名时整批不写入，已有员工密码不会改变。</p>
        <div className={styles.selectors}>
          <button disabled={!parsed}>
            {busy ? '导入中…' : '创建这些员工'}
          </button>
          <button type="button" onClick={onCancel}>
            取消
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function CompanyConfiguration({
  organization,
  onBusy,
}: {
  organization: ManagedOrganization;
  onBusy: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(
    organization.workspaces.find(
      (w) => w.id === organization.defaultWorkspaceId,
    )?.id ??
      organization.workspaces[0]?.id ??
      '',
  );
  const [view, setView] = useState<'employees' | 'environments' | 'quotas'>(
    'employees',
  );
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false);
  const canSwitch = () =>
    !busy && (!dirty || window.confirm('放弃尚未保存的修改？'));
  useEffect(() => {
    onBusy(dirty || busy);
    return () => onBusy(false);
  }, [dirty, busy, onBusy]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>公司 AI 员工、应用与用量</summary>
      {open && (
        <>
          {view !== 'employees' && organization.workspaces.length > 1 && (
            <label>
              历史工作区
              <select
                value={workspaceId}
                disabled={busy}
                onChange={(e) => {
                  if (canSwitch()) {
                    setWorkspaceId(e.target.value);
                    setDirty(false);
                  }
                }}
              >
                {organization.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <nav aria-label="公司配置">
            {(['employees', 'environments', 'quotas'] as const).map((v) => (
              <button
                key={v}
                aria-pressed={view === v}
                disabled={busy}
                onClick={() => {
                  if (canSwitch()) {
                    setView(v);
                    setDirty(false);
                  }
                }}
              >
                {
                  {
                    employees: '公司 AI 员工',
                    environments: '应用与电脑',
                    quotas: '用量',
                  }[v]
                }
              </button>
            ))}
          </nav>
          {workspaceId &&
            (view === 'employees' ? (
              <OrganizationAiAssignments
                organization={organization}
                defaults
                onBusy={setBusy}
              />
            ) : (
              <TenantResourceEditor
                key={`${workspaceId}/${view}`}
                organizationId={organization.id}
                workspaceId={workspaceId}
                mode={view}
                onDirty={setDirty}
                onBusy={setBusy}
              />
            ))}
        </>
      )}
    </details>
  );
}
