'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type { OrganizationDepartment } from '@allrice/contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import { organizationApi, organizationErrorMessage } from './organization-api';
import styles from './organization-administration.module.css';

export async function loadOrganizationDepartmentOptions(
  organizationId: string,
  signal?: AbortSignal,
) {
  const departments: OrganizationDepartment[] = [],
    seen = new Set<string>();
  let after: string | null = null;
  do {
    const params = after ? `?after=${encodeURIComponent(after)}` : '';
    const result: {
      departments: OrganizationDepartment[];
      nextCursor: string | null;
    } = await organizationApi(
      `/api/v1/admin/organizations/${organizationId}/departments${params}`,
      'GET',
      undefined,
      signal,
    );
    departments.push(...result.departments);
    after = result.nextCursor;
    if (after && seen.has(after)) throw Error('部门列表未能完整读取，请刷新。');
    if (after) seen.add(after);
  } while (after);
  return departments.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

export function OrganizationDepartments({
  organizationId,
  onBusy,
}: {
  organizationId: string;
  onBusy: (busy: boolean) => void;
}) {
  const [departments, setDepartments] = useState<OrganizationDepartment[]>([]);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<{
    item: OrganizationDepartment | null;
    requestId: string;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const base = `/api/v1/admin/organizations/${organizationId}/departments`;
  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError('');
    try {
      const result = await loadOrganizationDepartmentOptions(
        organizationId,
        request.signal,
      );
      if (!request.signal.aborted) setDepartments(result);
    } catch (e) {
      if (!request.signal.aborted) setError(organizationErrorMessage(e));
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [organizationId]);
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);
  useEffect(() => {
    onBusy(busy || !!draft);
    return () => onBusy(false);
  }, [busy, draft, onBusy]);
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
      setDraft(null);
      setNotice(message);
      await load();
    } catch (e) {
      setError(organizationErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const name = String(new FormData(event.currentTarget).get('name') ?? '');
    void mutate(
      draft.item ? `${base}/${draft.item.id}` : base,
      draft.item ? 'PATCH' : 'POST',
      draft.item
        ? {
            name,
            active: draft.item.active,
            expectedRevision: draft.item.revision,
          }
        : { name, requestId: draft.requestId },
      draft.item
        ? '部门名称已保存。'
        : '部门已创建，可以在员工资料中设置主部门。',
    );
  }
  return (
    <section aria-label="公司部门">
      <p className={styles.meta}>
        每位员工可设一个主部门，也可保持未分部门。部门与工作区分别管理；停用前请先调整关联员工。
      </p>
      <div className={styles.toolbar}>
        <AdminButton
          disabled={busy || !!draft}
          onClick={() => {
            setError('');
            setDraft({ item: null, requestId: crypto.randomUUID() });
          }}
        >
          新增部门
        </AdminButton>
        <AdminButton
          variant="quiet"
          disabled={busy || loading || !!draft}
          onClick={() => void load()}
        >
          刷新部门
        </AdminButton>
      </div>
      {draft && (
        <form
          key={draft.item?.id ?? draft.requestId}
          className={styles.form}
          onSubmit={save}
        >
          <fieldset disabled={busy}>
            <label>
              部门名称
              <input
                name="name"
                required
                maxLength={120}
                defaultValue={draft.item?.name ?? ''}
              />
            </label>
            <div className={styles.dialogFooter}>
              <AdminButton
                onClick={() => {
                  setDraft(null);
                  setError('');
                }}
              >
                取消
              </AdminButton>
              <AdminButton type="submit" variant="primary">
                {busy ? '保存中…' : '保存部门'}
              </AdminButton>
            </div>
          </fieldset>
        </form>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <table className={styles.departmentTable}>
        <thead>
          <tr>
            <th>部门</th>
            <th>关联员工</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {departments.map((item) => (
            <tr key={item.id}>
              <td>{item.name}</td>
              <td>{item.peopleCount}</td>
              <td>
                <AdminStatus tone={item.active ? 'success' : 'muted'}>
                  {item.active ? '可用' : '已停用'}
                </AdminStatus>
              </td>
              <td>
                <div className={styles.rowActions}>
                  <AdminButton
                    variant="quiet"
                    disabled={busy || !!draft}
                    onClick={() => {
                      setError('');
                      setDraft({ item, requestId: crypto.randomUUID() });
                    }}
                  >
                    改名
                  </AdminButton>
                  <AdminButton
                    variant="quiet"
                    disabled={busy || !!draft}
                    onClick={() =>
                      void mutate(
                        `${base}/${item.id}`,
                        'PATCH',
                        {
                          name: item.name,
                          active: !item.active,
                          expectedRevision: item.revision,
                        },
                        item.active
                          ? '部门已停用，历史记录保留。'
                          : '部门已启用。',
                      )
                    }
                  >
                    {item.active ? '停用部门' : '启用部门'}
                  </AdminButton>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {loading && (
        <p className={styles.meta} role="status">
          正在读取部门…
        </p>
      )}
      {!loading && !error && !departments.length && (
        <p className={styles.empty}>尚未设置部门，现有员工仍可正常工作。</p>
      )}
    </section>
  );
}
