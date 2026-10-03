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
import {
  AdminButton,
  AdminDialog,
  AdminIcon,
  AdminMenu,
  AdminStatus,
} from '../../components/admin/admin-ui';
import legacyStyles from './tenant-administration.module.css';
import styles from './organization-administration.module.css';

type OrganizationView = 'people' | 'employees' | 'environments' | 'quotas';
const companyTabs: { id: OrganizationView; label: string }[] = [
  { id: 'people', label: '员工账号' },
  { id: 'employees', label: '公司 AI 员工' },
  { id: 'environments', label: '应用与电脑' },
  { id: 'quotas', label: '用量' },
];

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

export function OrganizationAdministration({
  onNavigationStateChange,
}: {
  onNavigationStateChange?: (state: { busy: boolean; dirty: boolean }) => void;
} = {}) {
  const [organizations, setOrganizations] = useState<ManagedOrganization[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [savingCompany, setBusy] = useState(false);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [configurationBusy, setConfigurationBusy] = useState(false);
  const [configurationDirty, setConfigurationDirty] = useState(false);
  const [view, setView] = useState<OrganizationView>('people');
  const busy = savingCompany || peopleBusy || configurationBusy;
  const [editor, setEditor] = useState<'create' | 'edit' | null>(null);
  const controller = useRef<AbortController | null>(null);
  const selection = useRef('');
  selection.current = selectedId;
  const selected = organizations.find((o) => o.id === selectedId);
  useEffect(() => {
    onNavigationStateChange?.({
      busy: busy || !!editor,
      dirty: configurationDirty,
    });
    return () => onNavigationStateChange?.({ busy: false, dirty: false });
  }, [busy, editor, configurationDirty, onNavigationStateChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (busy || editor || configurationDirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy, editor, configurationDirty]);
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
  function canNavigate() {
    return (
      !busy && (!configurationDirty || window.confirm('放弃尚未保存的修改？'))
    );
  }
  function selectTab(nextView: OrganizationView) {
    if (view !== nextView && canNavigate()) {
      setConfigurationDirty(false);
      setView(nextView);
    }
  }
  return (
    <section className={styles.page} aria-label="组织管理">
      <header className={styles.pageHeader}>
        <div>
          <h1>组织管理</h1>
          <p>管理员工账号、公司资料与 AI 配发。</p>
        </div>
        <AdminButton
          icon="plus"
          disabled={busy || !!editor}
          onClick={() => {
            if (canNavigate()) setEditor('create');
          }}
        >
          新建公司
        </AdminButton>
      </header>
      {!editor && error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.companyBar}>
        <span className={styles.companyMark}>
          <AdminIcon name="organization" />
        </span>
        <div className={styles.companyCopy}>
          <h2
            aria-label={selected?.name ?? '选择公司'}
            className={styles.companyHeading}
          >
            <label className={styles.companyPicker}>
              <span className={styles.srOnly}>管理公司</span>
              <select
                aria-label="管理公司"
                value={selectedId}
                disabled={busy || !!editor}
                onChange={(event) => {
                  if (canNavigate()) {
                    setSelectedId(event.target.value);
                    setConfigurationDirty(false);
                    setView('people');
                  }
                }}
              >
                <option value="">选择公司</option>
                {organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <AdminIcon name="chevron" />
            </label>
          </h2>
          {selected && (
            <p className={styles.meta}>
              {selected.peopleCount} 名员工
              {selected.businessContext && <> · {selected.businessContext}</>}
            </p>
          )}
        </div>
        <div className={styles.actions}>
          {next && (
            <AdminButton
              variant="quiet"
              disabled={loading || busy || !!editor}
              onClick={() => void load(next)}
            >
              更多公司
            </AdminButton>
          )}
          {selected && (
            <AdminButton
              variant="quiet"
              icon="edit"
              disabled={busy || !!editor}
              onClick={() => {
                if (canNavigate()) setEditor('edit');
              }}
            >
              编辑公司
            </AdminButton>
          )}
          <AdminButton
            variant="icon"
            icon="refresh"
            aria-label="刷新公司"
            disabled={busy || loading || !!editor}
            onClick={() => {
              if (canNavigate()) void load();
            }}
          />
        </div>
      </div>
      {loading && !selected && (
        <p role="status" className={styles.meta}>
          正在读取公司…
        </p>
      )}
      {editor && (
        <AdminDialog
          title={editor === 'create' ? '新建公司' : '编辑公司'}
          busy={savingCompany}
          onClose={() => {
            setEditor(null);
            setError('');
          }}
        >
          <form key={editor} className={styles.form} onSubmit={saveCompany}>
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
                  placeholder="主营业务、客户群体和团队工作习惯"
                />
              </label>
              {error && (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              )}
              <div className={styles.dialogFooter}>
                <AdminButton
                  onClick={() => {
                    setEditor(null);
                    setError('');
                  }}
                >
                  取消
                </AdminButton>
                <AdminButton type="submit" variant="primary">
                  {savingCompany ? '保存中…' : '保存公司'}
                </AdminButton>
              </div>
            </fieldset>
          </form>
        </AdminDialog>
      )}
      {selected && (
        <>
          <nav className={styles.tabs} aria-label="公司配置" role="tablist">
            {companyTabs.map((tab, index) => (
              <button
                type="button"
                key={tab.id}
                role="tab"
                id={`company-tab-${tab.id}`}
                aria-controls={`company-panel-${tab.id}`}
                aria-selected={view === tab.id}
                tabIndex={view === tab.id ? 0 : -1}
                disabled={busy || !!editor}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => {
                  const offset =
                    event.key === 'ArrowRight'
                      ? 1
                      : event.key === 'ArrowLeft'
                        ? -1
                        : 0;
                  const nextIndex =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? companyTabs.length - 1
                        : offset
                          ? (index + offset + companyTabs.length) %
                            companyTabs.length
                          : null;
                  if (nextIndex !== null && canNavigate()) {
                    event.preventDefault();
                    setConfigurationDirty(false);
                    setView(companyTabs[nextIndex]!.id);
                    document
                      .getElementById(
                        `company-tab-${companyTabs[nextIndex]!.id}`,
                      )
                      ?.focus();
                  }
                }}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          {companyTabs.map((tab) => (
            <section
              key={tab.id}
              id={`company-panel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`company-tab-${tab.id}`}
              hidden={view !== tab.id}
            >
              {view === tab.id &&
                (tab.id === 'people' ? (
                  <OrganizationPeople
                    key={selected.id}
                    organization={selected}
                    onBusy={setPeopleBusy}
                    onChanged={() => void load()}
                  />
                ) : (
                  <CompanyConfiguration
                    key={`config-${selected.id}-${tab.id}`}
                    organization={selected}
                    view={tab.id}
                    onBusy={setConfigurationBusy}
                    onDirty={setConfigurationDirty}
                  />
                ))}
            </section>
          ))}
        </>
      )}
      {!selected && !loading && !editor && (
        <p className={styles.empty}>
          新建公司后，即可添加员工。员工从 allrice.bplabs.xyz 登录。
        </p>
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
  const [searchText, setSearchText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
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
      <div className={styles.sectionHeader}>
        <div className={styles.sectionTitle}>
          <h3>员工列表</h3>
          <span className={styles.meta}>
            {query
              ? `${people.length} 名匹配员工${next ? ' · 还有更多' : ''}`
              : `共 ${organization.peopleCount} 名员工`}
          </span>
        </div>
        <div className={styles.actions}>
          <AdminButton
            icon="upload"
            disabled={busy || editing}
            onClick={() => setEditor('bulk')}
          >
            批量导入
          </AdminButton>
          <AdminButton
            variant="primary"
            icon="plus"
            disabled={busy || editing}
            onClick={() => setEditor('new')}
          >
            添加员工
          </AdminButton>
        </div>
      </div>
      <div className={styles.toolbar}>
        <form
          className={styles.search}
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(searchText.trim());
            setSelectedPeople([]);
          }}
        >
          <AdminIcon name="search" />
          <input
            name="search"
            aria-label="查找员工"
            placeholder="姓名、账号或岗位"
            maxLength={160}
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            disabled={busy || editing}
          />
          {searchText && (
            <AdminButton
              variant="icon"
              icon="close"
              aria-label="清空查找"
              disabled={busy || editing}
              onClick={() => {
                setSearchText('');
                setQuery('');
                setSelectedPeople([]);
              }}
            />
          )}
          <AdminButton type="submit" variant="quiet" disabled={busy || editing}>
            查找
          </AdminButton>
        </form>
        <div className={styles.actions}>
          <AdminMenu label="批量配发" triggerLabel="批量配发" icon="chevron">
            <AdminButton
              variant="quiet"
              disabled={busy || editing || !selectedPeople.length}
              onClick={() =>
                setAiTarget({
                  target: { type: 'selected', userIds: selectedPeople },
                  title: `已选 ${selectedPeople.length} 人的 AI 员工`,
                })
              }
            >
              配发给已选员工
            </AdminButton>
            <AdminButton
              variant="quiet"
              disabled={busy || editing || !query.trim()}
              onClick={() =>
                setAiTarget({
                  target: { type: 'search', search: query },
                  title: `符合「${query}」的员工`,
                })
              }
            >
              配发给筛选结果
            </AdminButton>
            <AdminButton
              variant="quiet"
              disabled={busy || editing}
              onClick={() =>
                setAiTarget({
                  target: { type: 'all' },
                  title: '全公司员工的 AI 配发',
                })
              }
            >
              配发给全公司
            </AdminButton>
          </AdminMenu>
          <AdminButton
            variant="icon"
            icon="refresh"
            aria-label="刷新员工"
            disabled={busy || loading || editing}
            onClick={() => void load()}
          />
        </div>
      </div>
      {!editing && error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {!!selectedPeople.length && (
        <div className={styles.selection}>
          <span>已选 {selectedPeople.length} 人</span>
          <AdminButton
            variant="quiet"
            disabled={busy || editing}
            onClick={() => setSelectedPeople([])}
          >
            取消选择
          </AdminButton>
          <AdminButton
            icon="employee"
            disabled={busy || editing}
            onClick={() =>
              setAiTarget({
                target: { type: 'selected', userIds: selectedPeople },
                title: `已选 ${selectedPeople.length} 人的 AI 员工`,
              })
            }
          >
            配发 AI 员工
          </AdminButton>
        </div>
      )}
      {aiTarget && (
        <AdminDialog
          title={aiTarget.title}
          busy={aiBusy}
          onClose={() => setAiTarget(null)}
        >
          <OrganizationAiAssignments
            organization={organization}
            target={aiTarget.target}
            title={aiTarget.title}
            onBusy={setAiBusy}
            onClose={() => setAiTarget(null)}
          />
        </AdminDialog>
      )}
      {editor === 'bulk' ? (
        <AdminDialog
          title="批量导入员工"
          busy={busy}
          onClose={() => {
            setEditor(null);
            setError('');
          }}
        >
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <BulkPeopleImport
            busy={busy}
            onCancel={() => {
              setEditor(null);
              setError('');
            }}
            onSave={(rows) =>
              void mutate(
                base,
                'POST',
                { people: rows },
                `已创建 ${rows.length} 个员工账号。`,
              )
            }
          />
        </AdminDialog>
      ) : (
        editor && (
          <AdminDialog
            title={edited ? '编辑员工' : '添加员工'}
            busy={busy}
            onClose={() => {
              setEditor(null);
              setError('');
            }}
          >
            <form
              key={edited?.userId ?? 'new'}
              className={styles.form}
              onSubmit={savePerson}
            >
              <fieldset disabled={busy}>
                <div className={styles.twoFields}>
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
                </div>
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
                    <span className={styles.meta}>
                      可指定初始密码，员工登录后可以修改。
                    </span>
                  </label>
                )}
                {error && (
                  <p className={styles.error} role="alert">
                    {error}
                  </p>
                )}
                <div className={styles.dialogFooter}>
                  <AdminButton
                    onClick={() => {
                      setEditor(null);
                      setError('');
                    }}
                  >
                    取消
                  </AdminButton>
                  <AdminButton type="submit" variant="primary">
                    {busy ? '保存中…' : '保存员工'}
                  </AdminButton>
                </div>
              </fieldset>
            </form>
          </AdminDialog>
        )
      )}
      {reset && (
        <AdminDialog
          title={`重置 ${reset.displayName} 的密码`}
          busy={busy}
          onClose={() => {
            setReset(null);
            setError('');
          }}
        >
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                `${base}/${reset.userId}/password`,
                'POST',
                { password: new FormData(event.currentTarget).get('password') },
                '密码已重置，旧登录已退出。',
              );
            }}
          >
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
              {error && (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              )}
              <div className={styles.dialogFooter}>
                <AdminButton
                  onClick={() => {
                    setReset(null);
                    setError('');
                  }}
                >
                  取消
                </AdminButton>
                <AdminButton type="submit" variant="primary">
                  {busy ? '重置中…' : '重置密码'}
                </AdminButton>
              </div>
            </fieldset>
          </form>
        </AdminDialog>
      )}
      <table className={styles.peopleTable}>
        <colgroup>
          <col className={styles.checkColumn} />
          <col className={styles.personColumn} />
          <col />
          <col className={styles.statusColumn} />
          <col className={styles.actionsColumn} />
        </colgroup>
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="选择当前列表员工"
                disabled={busy || editing || !people.length}
                checked={
                  people.length > 0 &&
                  people.every((person) =>
                    selectedPeople.includes(person.userId),
                  )
                }
                onChange={(event) =>
                  setSelectedPeople(
                    event.target.checked
                      ? people.map((person) => person.userId)
                      : [],
                  )
                }
              />
            </th>
            <th>员工</th>
            <th>岗位与职能</th>
            <th>账号状态</th>
            <th className={styles.alignEnd}>操作</th>
          </tr>
        </thead>
        <tbody>
          {people.map((person) => (
            <tr
              key={person.userId}
              data-selected={selectedPeople.includes(person.userId)}
            >
              <td>
                <input
                  type="checkbox"
                  aria-label={`选择 ${person.displayName}`}
                  checked={selectedPeople.includes(person.userId)}
                  disabled={busy || editing}
                  onChange={(event) =>
                    setSelectedPeople((old) =>
                      event.target.checked
                        ? [...old, person.userId]
                        : old.filter((id) => id !== person.userId),
                    )
                  }
                />
              </td>
              <td>
                <div className={styles.person}>
                  <span className={styles.avatar} aria-hidden="true">
                    {Array.from(person.displayName)[0]}
                  </span>
                  <div className={styles.personCopy}>
                    <button
                      type="button"
                      className={styles.personName}
                      disabled={busy || editing}
                      onClick={() => setEditor(person)}
                    >
                      {person.displayName}
                    </button>
                    <small>{person.username ?? '待迁移英文账号'}</small>
                  </div>
                </div>
              </td>
              <td>
                <span>{person.jobTitle || '未填写岗位'}</span>
                <small className={styles.responsibilities}>
                  {person.responsibilities}
                </small>
              </td>
              <td>
                <AdminStatus
                  tone={
                    person.status === 'disabled' || !person.membershipActive
                      ? 'muted'
                      : person.status === 'invited'
                        ? 'warning'
                        : 'success'
                  }
                >
                  {person.status === 'disabled'
                    ? '已停用'
                    : !person.membershipActive
                      ? '公司访问已撤回'
                      : person.status === 'invited'
                        ? '待激活'
                        : '可登录'}
                </AdminStatus>
              </td>
              <td>
                <div className={styles.rowActions}>
                  <AdminButton
                    variant="quiet"
                    disabled={busy || editing}
                    onClick={() =>
                      setAiTarget({
                        target: { type: 'selected', userIds: [person.userId] },
                        title: `${person.displayName} 的 AI 员工`,
                      })
                    }
                  >
                    AI 员工
                  </AdminButton>
                  <AdminMenu label={`${person.displayName}的更多操作`}>
                    <AdminButton
                      variant="quiet"
                      disabled={busy || editing}
                      onClick={() => setEditor(person)}
                    >
                      编辑
                    </AdminButton>
                    <AdminButton
                      variant="quiet"
                      disabled={busy || editing}
                      onClick={() => setReset(person)}
                    >
                      重置密码
                    </AdminButton>
                    <AdminButton
                      variant={
                        person.status === 'disabled' ? 'quiet' : 'danger'
                      }
                      disabled={busy || editing}
                      onClick={() =>
                        void mutate(
                          `${base}/${person.userId}/status`,
                          'POST',
                          {
                            active: person.status === 'disabled',
                            expectedVersion: person.version,
                          },
                          person.status === 'disabled'
                            ? '账号已启用。'
                            : '账号已停用，历史工作和文件已保留。',
                        )
                      }
                    >
                      {person.status === 'disabled' ? '启用账号' : '停用账号'}
                    </AdminButton>
                  </AdminMenu>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {loading && !people.length && (
        <p role="status" className={styles.empty}>
          正在读取员工…
        </p>
      )}
      {!loading && !people.length && (
        <p className={styles.empty}>没有匹配的员工。可以添加员工或批量导入。</p>
      )}
      <footer className={styles.listFooter}>
        <span>员工从 allrice.bplabs.xyz 登录</span>
        {next ? (
          <AdminButton
            variant="quiet"
            disabled={busy || loading || editing}
            onClick={() => void load(next)}
          >
            更多员工
          </AdminButton>
        ) : (
          <span>普通员工权限</span>
        )}
      </footer>
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
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed) onSave(parsed);
      }}
    >
      <p className={styles.meta}>
        从 Excel 复制「英文账号、姓名、岗位、职能」四列，每行一人，最多 100 人。
      </p>
      <fieldset disabled={busy}>
        <label>
          员工表格
          <textarea
            aria-label="员工表格"
            className={styles.importInput}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={
              'snow\t小雪\t财务\t供应商对账\ndrink\t小李\t运营\t内容与活动'
            }
          />
        </label>
        {parsed ? (
          <p role="status" className={styles.meta}>
            将创建 {parsed.length} 人：
            {parsed.map((person) => person.displayName).join('、')}。
          </p>
        ) : (
          value && (
            <p role="alert" className={styles.error}>
              请检查四列格式、重复账号和必填的英文账号/姓名。单个单元格请勿换行。
            </p>
          )
        )}
        <p className={styles.meta}>
          初始密码统一为 admin@321。账号重名时整批不写入，已有员工密码不会改变。
        </p>
        <div className={styles.dialogFooter}>
          <AdminButton onClick={onCancel}>取消</AdminButton>
          <AdminButton type="submit" variant="primary" disabled={!parsed}>
            {busy ? '导入中…' : '创建这些员工'}
          </AdminButton>
        </div>
      </fieldset>
    </form>
  );
}

function CompanyConfiguration({
  organization,
  view,
  onBusy,
  onDirty,
}: {
  organization: ManagedOrganization;
  view: Exclude<OrganizationView, 'people'>;
  onBusy: (busy: boolean) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(
    organization.workspaces.find(
      (workspace) => workspace.id === organization.defaultWorkspaceId,
    )?.id ??
      organization.workspaces[0]?.id ??
      '',
  );
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  return (
    <div className={styles.configuration}>
      {organization.workspaces.length > 1 && (
        <label className={styles.workspaceSelector}>
          历史工作区
          <select
            aria-label="历史工作区"
            value={workspaceId}
            disabled={busy}
            onChange={(event) => {
              if (!dirty || window.confirm('放弃尚未保存的修改？')) {
                setWorkspaceId(event.target.value);
                setDirty(false);
              }
            }}
          >
            {organization.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {workspaceId ? (
        view === 'employees' ? (
          <OrganizationAiAssignments
            key={workspaceId}
            organization={organization}
            workspaceId={workspaceId}
            defaults
            onBusy={setBusy}
          />
        ) : (
          <div className={`${legacyStyles.panel} ${styles.resourcePanel}`}>
            <TenantResourceEditor
              key={`${workspaceId}/${view}`}
              organizationId={organization.id}
              workspaceId={workspaceId}
              mode={view}
              onDirty={setDirty}
              onBusy={setBusy}
            />
          </div>
        )
      ) : (
        <p className={styles.empty}>公司暂时没有可配置的工作区。</p>
      )}
    </div>
  );
}
