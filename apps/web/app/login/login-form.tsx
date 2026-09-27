'use client';

import { useState, type FormEvent } from 'react';
import { loginDestination } from '../../lib/portal/login-destination';

export function LoginForm(props: {
  bootstrap?: { username: string; homePath: string };
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      const account = String(data.get('username') ?? '').trim();
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(!props.bootstrap && account.includes('@')
            ? { email: account }
            : { username: account }),
          password: data.get('password'),
        }),
      });
      if (response.ok) {
        const result = (await response.json()) as { homePath?: string };
        window.location.assign(
          loginDestination(
            new URLSearchParams(window.location.search).get('next'),
            result.homePath ?? props.bootstrap?.homePath ?? '/chatflow',
            window.location.origin,
          ),
        );
      } else {
        const body = await response.json().catch(() => null);
        setError(
          response.status === 403 &&
            body?.error?.code === 'AUTHORIZATION_DENIED'
            ? '此账号无法登录这个入口。管理员请从 allrice-admin.bplabs.xyz 登录；员工请从 allrice.bplabs.xyz 登录。'
            : '登录失败，请检查账号和密码。',
        );
        setPending(false);
      }
    } catch {
      setError('暂时无法连接，请稍后重试。');
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="auth-form">
      <label>
        {props.bootstrap?.homePath === '/runtime-console'
          ? '管理员账号'
          : '账号'}
        <input
          name="username"
          type="text"
          autoComplete="username"
          defaultValue={props.bootstrap?.username ?? ''}
          placeholder="输入你的账号"
          required
        />
      </label>
      <label>
        密码
        <span className="auth-password">
          <input
            name="password"
            type={showPassword ? 'text' : 'password'}
            placeholder="输入密码"
            autoComplete="current-password"
            minLength={8}
            required
          />
          <button
            type="button"
            className="auth-password-toggle"
            aria-label={showPassword ? '隐藏密码' : '显示密码'}
            aria-pressed={showPassword}
            onClick={() => setShowPassword((value) => !value)}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
              <circle cx="12" cy="12" r="3" />
              {showPassword && <path d="m3 3 18 18" />}
            </svg>
          </button>
        </span>
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={pending} className="auth-submit">
        {pending ? '登录中…' : '登录'}
        {!pending && (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <path d="M4 12h16m-6-6 6 6-6 6" />
          </svg>
        )}
      </button>
    </form>
  );
}
