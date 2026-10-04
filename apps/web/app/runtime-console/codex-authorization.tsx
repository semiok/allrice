'use client';
import { AdminButton } from '../../components/admin/admin-ui';

import { useState } from 'react';
import styles from './governance-console.module.css';

export interface CodexAuthorization {
  id: string;
  state: string;
  verificationUri: string | null;
  userCode: string | null;
  expiresAt?: string;
  detailCode?: string | null;
}

function authorizationFailureMessage(flow: CodexAuthorization) {
  if (flow.state === 'expired') return '授权码已过期，请重新获取。';
  if (flow.state === 'canceled') return '本次授权已取消，可以重新开始。';
  const messages: Record<string, string> = {
    dsh_openai_codex_authorization_network_unavailable:
      '连接官方授权服务失败，请稍后重新获取授权码。',
    dsh_openai_codex_authorization_service_unavailable:
      '官方授权服务暂时不可用，已自动重试。请稍后重新获取授权码。',
    dsh_openai_codex_authorization_rate_limited:
      '官方授权服务提示请求过于频繁，请稍后再试。',
    dsh_openai_codex_authorization_runtime_failed:
      '授权服务启动失败，请重试；若仍失败，请联系管理员查看运行日志。',
  };
  return (
    messages[flow.detailCode ?? ''] ??
    '授权未完成，请重新获取授权码；若仍失败，请联系管理员查看运行日志。'
  );
}

export function CodexAuthorizationPanel({
  status,
  authorization,
  busy,
  onStart,
  onCancel,
}: {
  status: string;
  authorization: CodexAuthorization | null;
  busy: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  const [notice, setNotice] = useState('');
  const connected = status === 'connected';
  const active =
    authorization &&
    ['pending', 'running', 'awaiting_user'].includes(authorization.state);
  const flow = (
    <div className={styles.authorizationFlow}>
      <p>
        {connected
          ? '在官方页面登录这个位置对应的账号。授权完成后，启用状态保持不变。'
          : '在官方页面完成订阅账号授权，之后可手动启用。'}
      </p>
      {active ? (
        <>
          {authorization.state === 'awaiting_user' &&
          authorization.userCode &&
          authorization.verificationUri ? (
            <>
              <p>
                本次授权码由 AllRice 生成，请复制到官方授权页，无需到 Codex
                应用中查找。
              </p>
              <code className={styles.authorizationCode}>
                {authorization.userCode}
              </code>
              {authorization.expiresAt ? (
                <p>
                  本次流程有效至{' '}
                  {new Date(authorization.expiresAt).toLocaleTimeString(
                    'zh-CN',
                    { hour12: false },
                  )}
                </p>
              ) : null}
              <div className={styles.authorizationActions}>
                <AdminButton
                  type="button"
                  onClick={() => {
                    void (async () => {
                      try {
                        await navigator.clipboard.writeText(
                          authorization.userCode!,
                        );
                        setNotice('授权码已复制');
                      } catch {
                        setNotice('无法自动复制，请选中上方授权码手动复制。');
                      }
                    })();
                  }}
                >
                  复制授权码
                </AdminButton>
                <a
                  href={authorization.verificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  打开官方授权页
                </a>
              </div>
            </>
          ) : (
            <p role="status">正在获取官方授权码，连接不稳定时会自动重试…</p>
          )}
          <AdminButton type="button" disabled={busy} onClick={onCancel}>
            取消本次授权
          </AdminButton>
        </>
      ) : (
        <>
          {authorization &&
          ['failed', 'expired', 'canceled'].includes(authorization.state) ? (
            <p role={authorization.state === 'failed' ? 'alert' : 'status'}>
              {authorizationFailureMessage(authorization)}
              {connected ? '当前已保存的授权不受影响。' : ''}
            </p>
          ) : null}
          <AdminButton type="button" disabled={busy} onClick={onStart}>
            {connected ? '开始重新授权' : '连接 Codex 订阅'}
          </AdminButton>
        </>
      )}
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  );
  return (
    <section className={styles.authorizationPanel} aria-label="Codex 订阅连接">
      {connected ? (
        <>
          <strong>已连接</strong>
          <p>对话与图片共用此订阅，无需重复授权。</p>
          <details>
            <summary>
              重新授权 / 更换账号{active ? '（有待完成的授权）' : ''}
            </summary>
            {flow}
          </details>
        </>
      ) : (
        flow
      )}
    </section>
  );
}
