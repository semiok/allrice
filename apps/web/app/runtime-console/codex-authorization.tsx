'use client';

import { useState } from 'react';
import styles from './governance-console.module.css';

export interface CodexAuthorization {
  id: string;
  state: string;
  verificationUri: string | null;
  userCode: string | null;
  expiresAt?: string;
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
                <button
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
                </button>
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
            <p role="status">正在准备授权码…</p>
          )}
          <button type="button" disabled={busy} onClick={onCancel}>
            取消本次授权
          </button>
        </>
      ) : (
        <>
          {authorization &&
          ['failed', 'expired', 'canceled'].includes(authorization.state) ? (
            <p>
              上一次授权流程已结束。
              {connected ? '当前连接仍可使用。' : '需要连接时可以重新开始。'}
            </p>
          ) : null}
          <button type="button" disabled={busy} onClick={onStart}>
            {connected ? '开始重新授权' : '连接 Codex 订阅'}
          </button>
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
