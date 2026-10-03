'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import { AutomationSchema, type Automation } from '@allrice/contracts';
import { DshDialog } from '../chatflow/dsh-upstream/Dialog';
import styles from './folder-rules.module.css';
type Options = {
  workspaceId: string;
  editable: boolean;
  employees: { id: string; name: string }[];
  devices: {
    id: string;
    name: string;
    ready: boolean;
    grants: { id: string; label: string; version: number }[];
  }[];
};
type History = {
  observation: {
    status: string;
    errorCode: string | null;
    observedAt: string;
  } | null;
  events: {
    id: string;
    path: string;
    state: string;
    errorMessage: string | null;
    observedAt: string;
    sessionId: string | null;
    runId: string | null;
    runStatus: string | null;
  }[];
};
const runLabel: Record<string, string> = {
  queued: '待处理',
  running: '处理中',
  waiting_approval: '等待确认',
  succeeded: '已完成',
  failed: '未完成',
  canceled: '已停止',
  unknown: '结果待核实',
};
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!r.ok)
    throw Error(
      r.status === 403
        ? '请确认员工、文件夹授权和电脑自动工作仍可用。'
        : r.status === 401
          ? '请先登录。'
          : '暂时无法保存或读取，请刷新后重试。',
    );
  return r.status === 204 ? (undefined as T) : r.json();
}
export function FolderRules({ workspaceId }: { workspaceId?: string }) {
  const [rules, setRules] = useState<Automation[]>([]),
    [options, setOptions] = useState<Options | null>(null),
    [history, setHistory] = useState<Record<string, History>>({}),
    [draft, setDraft] = useState<Automation | null | undefined>(undefined),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false);
  const [name, setName] = useState(''),
    [prompt, setPrompt] = useState(''),
    [employee, setEmployee] = useState(''),
    [device, setDevice] = useState(''),
    [grant, setGrant] = useState(''),
    [path, setPath] = useState('.'),
    [extensions, setExtensions] = useState<string[]>(['pdf', 'xlsx', 'csv']),
    [ignore, setIgnore] = useState('成果');
  const query = `workspaceId=${encodeURIComponent(workspaceId ?? '')}`;
  async function reload() {
    if (!workspaceId) return;
    setBusy(true);
    setError('');
    try {
      const [list, choices] = await Promise.all([
        request<{ automations: unknown[] }>(
          `/api/v1/automations?${query}&triggerType=folder`,
        ),
        request<Options>(`/api/v1/automations/folder-options?${query}`),
      ]);
      if (choices.workspaceId !== workspaceId)
        throw Error('工作区已变化，请重新打开。');
      setRules(list.automations.map((r) => AutomationSchema.parse(r)));
      setOptions(choices);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (!workspaceId) return;
    void Promise.all([
      request<{ automations: unknown[] }>(
        `/api/v1/automations?${query}&triggerType=folder`,
        { signal: controller.signal },
      ),
      request<Options>(`/api/v1/automations/folder-options?${query}`, {
        signal: controller.signal,
      }),
    ])
      .then(([list, choices]) => {
        if (!active) return;
        if (choices.workspaceId !== workspaceId) throw Error('工作区已变化。');
        setRules(list.automations.map((r) => AutomationSchema.parse(r)));
        setOptions(choices);
        setLoaded(true);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : '读取失败');
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [query, workspaceId]);
  const selectedDevice = options?.devices.find((d) => d.id === device);
  function edit(rule: Automation | null) {
    setDraft(rule);
    setName(rule?.name ?? '');
    setPrompt(rule?.prompt ?? '');
    setEmployee(rule?.employeeAssignmentId ?? options?.employees[0]?.id ?? '');
    const d = options?.devices.find((d) => d.ready && d.grants.length);
    setDevice(rule?.folder?.deviceId ?? d?.id ?? '');
    setGrant(rule?.folder?.folderGrantId ?? d?.grants[0]?.id ?? '');
    setPath(rule?.folder?.relativePath ?? '.');
    setExtensions(rule?.folder?.extensions ?? ['pdf', 'xlsx', 'csv']);
    setIgnore(rule?.folder?.ignorePaths.join('\n') ?? '成果');
    setError('');
  }
  async function save() {
    if (busy || !workspaceId || !selectedDevice) return;
    const g = selectedDevice.grants.find((g) => g.id === grant);
    if (!g) return;
    setBusy(true);
    setError('');
    try {
      const folder = {
        contractVersion: 1,
        deviceId: device,
        folderGrantId: grant,
        folderGrantVersion: g.version,
        relativePath: path.trim() || '.',
        extensions,
        ignorePaths: ignore
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean),
      };
      await request(
        `/api/v1/automations${draft ? `/${draft.id}?${query}` : ''}`,
        {
          method: draft ? 'PATCH' : 'POST',
          body: JSON.stringify(
            draft
              ? {
                  name,
                  prompt,
                  employeeAssignmentId: employee,
                  folder,
                  expectedRevision: draft.revision,
                }
              : {
                  workspaceId,
                  name,
                  prompt,
                  employeeAssignmentId: employee,
                  triggerType: 'folder',
                  conversationMode: 'new_each_run',
                  folder,
                },
          ),
        },
      );
      setDraft(undefined);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  async function change(rule: Automation, enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      await request(`/api/v1/automations/${rule.id}?${query}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expectedRevision: rule.revision,
          status: enabled ? 'enabled' : 'paused',
        }),
      });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  async function remove(rule: Automation) {
    setBusy(true);
    setError('');
    try {
      await request(`/api/v1/automations/${rule.id}?${query}`, {
        method: 'DELETE',
      });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }
  async function showHistory(rule: Automation) {
    setError('');
    try {
      const value = await request<History>(
        `/api/v1/automations/${rule.id}/folder-events?${query}`,
      );
      setHistory((h) => ({ ...h, [rule.id]: value }));
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    }
  }
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>文件夹自动处理</h1>
          <p>
            把文件放进指定文件夹，AI 员工会自动处理，并在新的工作中交付成果。
          </p>
        </div>
        <Link href="/chatflow">返回工作台</Link>
      </header>
      {!workspaceId ? (
        <p>请从工作台设置中的「员工工作方式」打开此页面。</p>
      ) : (
        <>
          <div className={styles.toolbar}>
            <Button
              disabled={busy || !options?.editable}
              onClick={() => edit(null)}
            >
              添加文件夹规则
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void reload()}
            >
              刷新
            </Button>
          </div>
          {error ? <p role="alert">{error}</p> : null}
          {!loaded && !error ? <p role="status">正在读取文件夹规则…</p> : null}
          {loaded && !options?.editable ? (
            <p>请先在员工工作方式中开启「我的电脑自动工作」。</p>
          ) : null}
          {loaded && !rules.length ? (
            <div className={styles.empty}>
              <p>还没有文件夹规则。你可以让员工自动读取 PDF、Excel 或 CSV。</p>
              <p>
                需要新版 Bridge
                保持在线，并在「我的电脑」选择允许使用的文件夹。添加规则时，已有文件会作为起点；之后的新文件或新版本才会启动工作。
              </p>
            </div>
          ) : null}
          {rules.map((rule) => {
            const h = history[rule.id],
              choice = options?.devices.find(
                (d) => d.id === rule.folder?.deviceId,
              );
            const listening =
              rule.status === 'enabled' &&
              choice?.ready &&
              h?.observation?.status === 'listening';
            return (
              <section
                className={styles.card}
                key={rule.id}
                aria-label={`文件夹规则 ${rule.name}`}
              >
                <div className={styles.row}>
                  <div>
                    <h2>{rule.name}</h2>
                    <p>
                      {choice?.name ?? '我的电脑'} ·{' '}
                      {choice?.grants.find(
                        (g) => g.id === rule.folder?.folderGrantId,
                      )?.label ?? '已授权文件夹'}
                      {rule.folder?.relativePath !== '.'
                        ? ` / ${rule.folder?.relativePath}`
                        : ''}
                    </p>
                  </div>
                  <Switch
                    label={`启用 ${rule.name}`}
                    checked={rule.status === 'enabled'}
                    disabled={
                      busy || (!options?.editable && rule.status !== 'enabled')
                    }
                    onChange={(v) => void change(rule, v)}
                  />
                </div>
                <p className={styles.muted}>
                  {rule.status === 'paused'
                    ? '已暂停'
                    : listening
                      ? '正在监听'
                      : choice?.ready
                        ? '已启用，等待监听状态'
                        : '等待电脑就绪'}{' '}
                  ·{' '}
                  {rule.folder?.extensions
                    .map((v) => v.toUpperCase())
                    .join(' / ')}
                </p>
                <p>{rule.prompt}</p>
                <div className={styles.toolbar}>
                  <Button
                    variant="outline"
                    disabled={busy || !options?.editable}
                    onClick={() => edit(rule)}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void showHistory(rule)}
                  >
                    最近处理
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void remove(rule)}
                  >
                    删除规则
                  </Button>
                </div>
                {h ? (
                  <div className={styles.history}>
                    {!h.events.length ? (
                      <p>还没有新文件版本。</p>
                    ) : (
                      h.events.map((e) => (
                        <div className={styles.event} key={e.id}>
                          <div>
                            <strong>{e.path}</strong>
                            <small>
                              {new Date(e.observedAt).toLocaleString('zh-CN')}
                            </small>
                          </div>
                          <span>
                            {e.runStatus
                              ? (runLabel[e.runStatus] ?? '状态待核实')
                              : e.state === 'blocked'
                                ? '未启动'
                                : e.state === 'received'
                                  ? '等待导入'
                                  : '正在校验原件'}
                          </span>
                          {e.runId && e.sessionId ? (
                            <Link href={`/chatflow?session=${e.sessionId}`}>
                              查看工作与成果
                            </Link>
                          ) : null}
                          {e.errorMessage ? <p>{e.errorMessage}</p> : null}
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </section>
            );
          })}
          {draft !== undefined ? (
            <DshDialog
              ariaLabel={draft ? '编辑文件夹规则' : '添加文件夹规则'}
              onClose={() => {
                if (!busy) setDraft(undefined);
              }}
              title={draft ? '编辑文件夹规则' : '添加文件夹规则'}
            >
              <form
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <label>
                  规则名称
                  <Input
                    aria-label="规则名称"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={160}
                    required
                    disabled={busy}
                  />
                </label>
                <label>
                  负责的 AI 员工
                  <select
                    aria-label="负责的 AI 员工"
                    value={employee}
                    onChange={(e) => setEmployee(e.target.value)}
                    disabled={busy}
                    required
                  >
                    {options?.employees.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  处理电脑
                  <select
                    aria-label="处理电脑"
                    value={device}
                    onChange={(e) => {
                      setDevice(e.target.value);
                      setGrant(
                        options?.devices.find((d) => d.id === e.target.value)
                          ?.grants[0]?.id ?? '',
                      );
                    }}
                    disabled={busy}
                    required
                  >
                    <option value="">请选择在线电脑</option>
                    {options?.devices.map((d) => (
                      <option key={d.id} value={d.id} disabled={!d.ready}>
                        {d.name}
                        {d.ready ? '' : ' · 请安装新版 Bridge 并保持在线'}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  已授权文件夹
                  <select
                    aria-label="已授权文件夹"
                    value={grant}
                    onChange={(e) => setGrant(e.target.value)}
                    disabled={busy}
                    required
                  >
                    {selectedDevice?.grants.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  监听子文件夹
                  <Input
                    aria-label="监听子文件夹"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder=". 表示整个已授权文件夹"
                    disabled={busy}
                  />
                </label>
                <fieldset>
                  <legend>处理文件类型</legend>
                  {['pdf', 'xlsx', 'csv'].map((ext) => (
                    <label className={styles.check} key={ext}>
                      <input
                        type="checkbox"
                        checked={extensions.includes(ext)}
                        onChange={(e) =>
                          setExtensions((v) =>
                            e.target.checked
                              ? [...v, ext]
                              : v.filter((x) => x !== ext),
                          )
                        }
                        disabled={busy}
                      />
                      {ext.toUpperCase()}
                    </label>
                  ))}
                </fieldset>
                <label>
                  处理要求
                  <textarea
                    aria-label="处理要求"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={4}
                    required
                    maxLength={40000}
                    placeholder="例如：读取每份报表，汇总关键数据，并生成结果文件。"
                    disabled={busy}
                  />
                </label>
                <label>
                  排除子文件夹（每行一个）
                  <textarea
                    aria-label="排除子文件夹"
                    value={ignore}
                    onChange={(e) => setIgnore(e.target.value)}
                    rows={2}
                    required
                    disabled={busy}
                  />
                </label>
                <p className={styles.muted}>
                  原文件保持不变，处理结果在工作台交付。临时文件、隐藏文件与排除目录不触发任务。电脑断线后，恢复同一授权范围时再继续校验新版本。
                </p>
                {error ? <p role="alert">{error}</p> : null}
                <div className={styles.toolbar}>
                  <Button
                    type="submit"
                    disabled={
                      busy ||
                      !selectedDevice?.ready ||
                      !grant ||
                      !employee ||
                      !extensions.length ||
                      !ignore.trim()
                    }
                  >
                    {busy ? '正在保存…' : '保存规则'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setDraft(undefined)}
                  >
                    取消
                  </Button>
                </div>
              </form>
            </DshDialog>
          ) : null}
        </>
      )}
    </main>
  );
}
