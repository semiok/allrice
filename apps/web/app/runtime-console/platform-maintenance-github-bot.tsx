'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MaintenanceGithubBotSchema,
  PlatformRepositoryTokenSchema,
  platformRepository,
  type MaintenanceGithubBot,
} from '@allrice/database/technical-contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';

const endpoint = '/api/v1/admin/technical-assistant/maintenance/github-bot';
const repositoryOwner = platformRepository.fullName.split('/')[0]!;
const tokenCreationUrl =
  'https://github.com/settings/personal-access-tokens/new?' +
  new URLSearchParams({
    name: 'AllRice-maintenance',
    target_name: repositoryOwner,
    expires_in: '30',
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
    actions: 'read',
  });
type Pending = { requestId: string; expectedRevision: number };
export function PlatformMaintenanceGithubBot() {
  const [settings, setSettings] = useState<MaintenanceGithubBot | null>(null),
    [token, setToken] = useState(''),
    [login, setLogin] = useState(repositoryOwner),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Pending | null>(null),
    [notice, setNotice] = useState('');
  const mounted = useRef(false),
    sequence = useRef(0);
  const read = useCallback(async () => {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) throw Error('configuration_unavailable');
    return MaintenanceGithubBotSchema.parse(await response.json());
  }, []);
  useEffect(() => {
    mounted.current = true;
    const epoch = ++sequence.current;
    void read()
      .then((value) => {
        if (mounted.current && sequence.current === epoch) setSettings(value);
      })
      .catch(() => {
        if (mounted.current && sequence.current === epoch)
          setNotice('GitHub 授权配置暂不可读，请刷新核对。');
      });
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, [read]);
  async function refresh() {
    if (busy) return;
    const epoch = ++sequence.current;
    setBusy(true);
    try {
      const value = await read();
      if (!mounted.current || sequence.current !== epoch) return;
      setSettings(value);
      if (pending) {
        if (
          value.lastWriteRequestId === pending.requestId &&
          value.revision === pending.expectedRevision + 1
        ) {
          setPending(null);
          setNotice('已确认上次配置结果。');
        } else {
          setPending(null);
          setNotice(
            '已读取当前配置，上次请求未确认。需要变更时，请重新输入令牌并保存。',
          );
        }
      } else setNotice('已刷新 GitHub 授权配置。');
    } catch {
      if (mounted.current && sequence.current === epoch)
        setNotice('当前配置暂未确认，请稍后刷新。');
    } finally {
      if (mounted.current && sequence.current === epoch) setBusy(false);
    }
  }
  async function write(action: 'replace' | 'remove') {
    if (!settings || busy || pending) return;
    const secret = token.trim();
    if (
      action === 'replace' &&
      (!PlatformRepositoryTokenSchema.safeParse(secret).success ||
        !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(login.trim()))
    ) {
      setNotice('请填写 GitHub 用户名和细粒度个人令牌。');
      return;
    }
    const request = {
      requestId: crypto.randomUUID(),
      expectedRevision: settings.revision,
    };
    const epoch = ++sequence.current;
    setBusy(true);
    setPending(request);
    setNotice('');
    setToken('');
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...request,
          action,
          ...(action === 'replace'
            ? { token: secret, expectedLogin: login.trim() }
            : {}),
        }),
      });
      if (!response.ok) throw Error('write_unconfirmed');
      const value = MaintenanceGithubBotSchema.parse(await response.json());
      if (
        value.lastWriteRequestId !== request.requestId ||
        value.revision !== request.expectedRevision + 1
      )
        throw Error('write_changed');
      if (mounted.current && sequence.current === epoch) {
        setSettings(value);
        setPending(null);
        setNotice(
          action === 'remove'
            ? 'GitHub 授权已移除。'
            : 'GitHub 授权已保存。账号与仓库已核对；提交时继续检查冻结身份和当前权限。',
        );
      }
    } catch {
      const value = await read().catch(() => null);
      if (!mounted.current || sequence.current !== epoch) return;
      if (value) setSettings(value);
      if (
        value?.lastWriteRequestId === request.requestId &&
        value.revision === request.expectedRevision + 1
      ) {
        setPending(null);
        setNotice('已回读确认配置结果。');
      } else
        setNotice(
          '配置结果尚未确认，请刷新核对。令牌输入已清空，不会自动重复提交。',
        );
    } finally {
      if (mounted.current && sequence.current === epoch) setBusy(false);
    }
  }
  return (
    <details className={css.card} aria-label="GitHub 提交账号">
      <summary>
        GitHub 提交账号 ·{' '}
        {settings?.configured ? '已配置' : settings ? '未配置' : '读取中'}
      </summary>
      <p className={css.meta}>
        统一平台使用你的 GitHub 账号提交修复
        PR，并读取构建与测试结果。只需在这里授权一次，各公司部署只上报问题，不需要分别授权。PR
        标题、标签与来源记录会标明公司。
      </p>
      {settings && (
        <AdminStatus
          tone={settings.state === 'configured' ? 'muted' : 'warning'}
        >
          {settings.state === 'configured'
            ? 'GitHub 账号与仓库身份已核对'
            : settings.state === 'unavailable'
              ? '已保存的授权不可用，请重新配置'
              : '尚未配置 GitHub 授权'}
        </AdminStatus>
      )}
      <p className={css.meta}>
        登录 semiok 创建细粒度个人令牌，Resource owner 选择 semiok，Only select
        repositories 仅选择 allrice。需要 Contents、Pull requests 与
        Issues（公司标签）的读写权限，Actions 的只读权限。
      </p>
      <a href={tokenCreationUrl} target="_blank" rel="noreferrer">
        创建 GitHub 细粒度令牌
      </a>
      {settings?.identity && (
        <p className={css.meta}>
          提交账号：{settings.identity.login} · 授权 v{settings.revision}
        </p>
      )}
      {settings?.state === 'central_disabled' && (
        <p role="status">
          当前是公司部署，仅上报检查报告。请在统一管理平台配置 GitHub 提交账号。
        </p>
      )}
      <div className={css.controls}>
        <label>
          GitHub 用户名
          <input
            aria-label="GitHub 用户名"
            value={login}
            maxLength={39}
            disabled={busy || !!pending}
            onChange={(e) => setLogin(e.target.value)}
          />
        </label>
        <label>
          GitHub 个人令牌
          <input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={251}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={busy || !!pending}
            aria-label="GitHub 个人令牌"
          />
        </label>
        <AdminButton
          disabled={
            !settings ||
            busy ||
            !!pending ||
            !token.trim() ||
            !login.trim() ||
            settings.state === 'central_disabled'
          }
          onClick={() => void write('replace')}
        >
          保存 GitHub 授权
        </AdminButton>
        <AdminButton
          disabled={!settings?.configured || busy || !!pending}
          onClick={() => void write('remove')}
        >
          移除 GitHub 授权
        </AdminButton>
        <AdminButton disabled={busy} onClick={() => void refresh()}>
          刷新 GitHub 授权
        </AdminButton>
      </div>
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
