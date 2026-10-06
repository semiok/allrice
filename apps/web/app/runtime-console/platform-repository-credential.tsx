'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PlatformRepositoryCredentialSchema,
  PlatformRepositoryTokenSchema,
  type PlatformRepositoryCredential,
} from '@allrice/database/technical-contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';

const endpoint = '/api/v1/admin/technical-assistant/repository-credential';
type Pending = { requestId: string; expectedRevision: number };
export function PlatformRepositoryCredentialPanel() {
  const [settings, setSettings] = useState<PlatformRepositoryCredential | null>(
      null,
    ),
    [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Pending | null>(null),
    [notice, setNotice] = useState('');
  const mounted = useRef(false),
    sequence = useRef(0);
  const read = useCallback(async () => {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) throw Error('configuration_unavailable');
    return PlatformRepositoryCredentialSchema.parse(await response.json());
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
          setNotice('仓库授权配置暂不可读，请刷新核对。');
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
      } else setNotice('已刷新仓库授权配置。');
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
      !PlatformRepositoryTokenSchema.safeParse(secret).success
    ) {
      setNotice('请填写 GitHub 的细粒度仓库令牌。');
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
          ...(action === 'replace' ? { token: secret } : {}),
        }),
      });
      if (!response.ok) throw Error('write_unconfirmed');
      const value = PlatformRepositoryCredentialSchema.parse(
        await response.json(),
      );
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
            ? '仓库授权已移除。'
            : '仓库授权已保存。访问权限将在候选发布时核对。',
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
    <details className={css.card} aria-label="平台仓库授权">
      <summary>
        平台仓库授权 ·{' '}
        {settings?.configured ? '已配置' : settings ? '未配置' : '读取中'}
      </summary>
      <p className={css.meta}>
        用于把已验证的修复候选提交到 semiok/allrice，并读取该 PR
        的构建与测试结果。每位平台管理员单独配置自己的授权。
      </p>
      {settings && (
        <AdminStatus
          tone={settings.state === 'configured' ? 'muted' : 'warning'}
        >
          {settings.state === 'configured'
            ? '已保存，仓库访问待核对'
            : settings.state === 'unavailable'
              ? '已保存的授权不可用，请重新配置'
              : '尚未配置仓库授权'}
        </AdminStatus>
      )}
      <p className={css.meta}>
        在 GitHub 创建细粒度令牌，仅选择 semiok/allrice。需要 Contents 与 Pull
        requests 的读写权限，以及 Actions 与 Checks 的只读权限。
      </p>
      <a
        href="https://github.com/settings/personal-access-tokens/new"
        target="_blank"
        rel="noreferrer"
      >
        创建 GitHub 细粒度令牌
      </a>
      <div className={css.controls}>
        <label>
          仓库令牌
          <input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={251}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={busy || !!pending}
            aria-label="仓库令牌"
          />
        </label>
        <AdminButton
          disabled={!settings || busy || !!pending || !token.trim()}
          onClick={() => void write('replace')}
        >
          保存仓库授权
        </AdminButton>
        <AdminButton
          disabled={!settings?.configured || busy || !!pending}
          onClick={() => void write('remove')}
        >
          移除仓库授权
        </AdminButton>
        <AdminButton disabled={busy} onClick={() => void refresh()}>
          刷新仓库授权
        </AdminButton>
      </div>
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
