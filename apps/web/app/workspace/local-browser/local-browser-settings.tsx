'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  BrowserProfileSchema,
  type BrowserProfile,
  type BridgeDevice,
} from '@allrice/contracts';
import styles from './local-browser-settings.module.css';

type Grant = {
  grantId: string;
  grantRevision: number;
  deviceId: string;
  deviceName: string;
  logicalProfileId: string;
  persistLogin: boolean;
  profile: BrowserProfile;
  enabled: boolean;
  cleanupRequested: boolean;
  cleanupConfirmed: boolean;
  cleanupErrorCode: string | null;
};
export function LocalBrowserSettings({
  workspaceId,
  embedded = false,
}: {
  workspaceId: string;
  embedded?: boolean;
}) {
  const [grants, setGrants] = useState<Grant[]>([]),
    [devices, setDevices] = useState<BridgeDevice[]>([]),
    [enabled, setEnabled] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [revision, setRevision] = useState(0),
    [deviceId, setDeviceId] = useState(''),
    [origins, setOrigins] = useState(''),
    [allowUploads, setUploads] = useState(false),
    [allowDownloads, setDownloads] = useState(false),
    [allowHumanCredentials, setCredentials] = useState(false),
    [persistLogin, setPersistLogin] = useState(false);
  const endpoint = '/api/v1/admin/local-browser';
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    setError('');
    const load = async () => {
      try {
        const response = await fetch(
          `${endpoint}?workspaceId=${encodeURIComponent(workspaceId)}`,
          { cache: 'no-store', signal: abort.signal },
        );
        if (!response.ok)
          throw Error('无法读取本地浏览器授权，请检查当前账号和租户。');
        const body = await response.json();
        if (abort.signal.aborted) return;
        setEnabled(body.enabled);
        setGrants(body.grants);
        setDevices(body.devices);
        setError('');
        if (
          body.grants.some(
            (g: Grant) => g.cleanupRequested && !g.cleanupConfirmed,
          )
        )
          timer = setTimeout(() => void load(), 3000);
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : '读取失败');
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [workspaceId, revision]);
  async function mutate(
    method: 'POST' | 'PATCH',
    body: Record<string, unknown>,
  ) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...body }),
      });
      if (!response.ok) throw Error('操作尚未确认，请刷新核实授权状态。');
      await response.json();
      setNotice(
        method === 'POST'
          ? '授权已登记；仍需本机启用，并在任务中启动独立浏览器。'
          : '授权已撤销；本机登录资料是否清理完成，以设备回执为准。',
      );
      setRevision((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const values = origins.split(/\s+/).filter(Boolean);
    const profile = BrowserProfileSchema.safeParse({
      version: 1,
      origins: values,
      allowUploads,
      allowDownloads,
      allowHumanCredentials,
      lifetimeMs: 300000,
      maximumFileBytes: 1000000,
    });
    if (!profile.success || !devices.some((d) => d.id === deviceId)) {
      setError(
        '请选择自己的设备，并填写 1–8 个完整 HTTPS 站点来源，每行一个；不含路径、账号密码或通配符。',
      );
      return;
    }
    await mutate('POST', { deviceId, profile: profile.data, persistLogin });
  }
  async function copyPrompt(g: Grant) {
    try {
      await navigator.clipboard.writeText(
        `请使用本地浏览器 local.browser.workspace，在设备 ${g.deviceName} 上打开 ${g.profile.origins[0]}。授权 ID：${g.grantId}。不要改用云端或个人 Chrome；需要提交、上传或下载时先请求批准。`,
      );
      setNotice('已复制任务说明；回到工作台，补充要完成的具体任务再发送。');
    } catch {
      setError('复制失败，可手动复制授权 ID 和允许站点。');
    }
  }
  return (
    <section className={styles.root} aria-label="本地浏览器授权">
      <header>
        <div>
          {!embedded && <h1>本地浏览器授权</h1>}
          <p>在 Bridge 设备上使用专属浏览器，和个人 Chrome 分开。</p>
        </div>
        <button
          type="button"
          disabled={loading || busy}
          onClick={() => setRevision((n) => n + 1)}
        >
          刷新状态
        </button>
      </header>
      <p>
        浏览器使用 Chromium 自身沙箱与受控网络代理，
        <strong>不是本地命令的 Linux VM 沙箱</strong>。不读取个人 Chrome 的
        Cookie、历史或标签页。无需选择文件夹；文件读写权限不会因此自动开放。
      </p>
      <p>
        网页观察、截图和已批准下载的工件会回传
        SaaS。上传会把你明确选择的文件发送到批准站点；填写凭证需要单独允许，密码不发送给模型。当前每次工作台最长
        5 分钟，单个文件最多 1 MB。
      </p>
      <p>
        设备授权不会自动增加 Rice
        的工具或权限。管理员还需为员工配置本地浏览器工具和对应执行政策；发布后在新的
        Run 中生效，当前运行中的冻结配置不会改变。
      </p>
      {loading && <p role="status">正在读取授权…</p>}
      {!loading && !enabled && (
        <p role="status">
          当前环境尚未启用本地浏览器。已有授权仍可查看或撤销；不会启动新的浏览器。
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={!enabled || loading || busy}>
          <legend>新建专属浏览器授权</legend>
          <label>
            执行设备
            <select
              aria-label="执行设备"
              required
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
            >
              <option value="">请选择自己的 Bridge</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.status === 'online' ? '在线' : '离线'}
                </option>
              ))}
            </select>
          </label>
          <label>
            允许站点
            <textarea
              aria-label="允许站点"
              required
              rows={3}
              value={origins}
              onChange={(e) => setOrigins(e.target.value)}
              placeholder={'https://example.com\nhttps://login.example.com'}
            />
          </label>
          <p>
            仅支持明确列出的公网 HTTPS
            来源（443）；跳转、子资源或登录提供方需分别列入。此处不能授权
            localhost、内网地址或任意端口。
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={allowUploads}
              onChange={(e) => setUploads(e.target.checked)}
            />
            允许上传明确选择的文件（每次仍需审批）
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={allowDownloads}
              onChange={(e) => setDownloads(e.target.checked)}
            />
            允许下载并保存为 SaaS 工件（每次仍需审批）
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={allowHumanCredentials}
              onChange={(e) => setCredentials(e.target.checked)}
            />
            允许本人在人工接管时输入登录凭证
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={persistLogin}
              onChange={(e) => setPersistLogin(e.target.checked)}
            />
            保留这个专属浏览器的登录资料供后续任务使用
          </label>
          <p>
            {persistLogin
              ? '登录资料以本机 0700 目录 / 0600 私有文件保存，未加密、不是 Keychain。只供当前设备、账号和这次授权使用。撤销后需设备在线完成真实清理。'
              : '默认不保存登录资料，每次任务使用新隔离会话；不会继承之前任务的控制权。'}
          </p>
          <button type="submit">保存浏览器授权</button>
        </fieldset>
      </form>
      {!loading && !devices.length && (
        <p>
          尚无可用的配对设备。请先连接 Bridge；不需要为浏览器选择本地文件夹。
        </p>
      )}
      <h2>已有授权</h2>
      {!loading && !grants.length && (
        <p>暂无授权；只安装 Bridge 不会自动开放浏览器控制。</p>
      )}
      {grants.map((g) => (
        <article key={g.grantId} aria-label={`浏览器授权 ${g.grantId}`}>
          <header>
            <strong>{g.deviceName}</strong>
            <span>{g.enabled ? '已授权' : '已撤销'}</span>
          </header>
          <p>{g.profile.origins.join('、')}</p>
          <p>
            上传：{g.profile.allowUploads ? '允许，经逐次审批' : '关闭'} ·
            下载：{g.profile.allowDownloads ? '允许，经逐次审批' : '关闭'} ·
            人工凭证：{g.profile.allowHumanCredentials ? '允许' : '关闭'}
          </p>
          <p>
            登录资料：
            {g.persistLogin
              ? '允许在本机私有文件保留（未加密）'
              : '每次任务隔离，不保留'}
          </p>
          {g.cleanupRequested && (
            <p role="status">
              {g.cleanupConfirmed
                ? '设备已确认清理此授权的登录资料'
                : g.cleanupErrorCode
                  ? '设备清理未完成，请检查 Bridge 后刷新；不能视为已删除'
                  : '等待设备确认清理；离线设备需重新连接'}
            </p>
          )}
          <details>
            <summary>授权身份</summary>
            <p>
              授权 ID：<code>{g.grantId}</code> · 版本 {g.grantRevision}
            </p>
            <p>
              专属 Profile：<code>{g.logicalProfileId}</code>
            </p>
          </details>
          <div className={styles.actions}>
            <button
              disabled={busy || !enabled || !g.enabled}
              onClick={() => void copyPrompt(g)}
            >
              复制启动任务说明
            </button>
            <button
              disabled={busy || !g.enabled}
              onClick={() =>
                void mutate('PATCH', { action: 'revoke', grantId: g.grantId })
              }
            >
              撤销并清理登录资料
            </button>
          </div>
        </article>
      ))}
      <p>{!embedded && <Link href="/chatflow">返回工作台</Link>}</p>
    </section>
  );
}
