'use client';

import { useState, type FormEvent } from 'react';
import { loginDestination } from '../../lib/portal/login-destination';

export function LoginForm(props: {
  bootstrap?: { username: string; homePath: string };
}) {
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
          : '员工账号'}
        <input
          name="username"
          type="text"
          autoComplete="username"
          defaultValue={props.bootstrap?.username ?? ''}
          placeholder="英文昵称"
          required
        />
      </label>
      <label>
        密码
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={8}
          required
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button disabled={pending}>{pending ? '登录中…' : '登录'}</button>
    </form>
  );
}
