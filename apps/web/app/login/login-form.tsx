'use client';

import { useState, type FormEvent } from 'react';

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
    const response = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(props.bootstrap
          ? { username: data.get('username') }
          : { email: data.get('email') }),
        password: data.get('password'),
      }),
    });
    if (response.ok) {
      const result = (await response.json()) as { homePath?: string };
      window.location.assign(
        result.homePath ?? props.bootstrap?.homePath ?? '/chatflow',
      );
    } else {
      setError('登录失败，请检查账号和密码。');
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="auth-form">
      {props.bootstrap ? (
        <label>
          账号
          <input
            name="username"
            type="text"
            autoComplete="username"
            defaultValue={props.bootstrap.username}
            required
          />
        </label>
      ) : (
        <label>
          邮箱
          <input name="email" type="email" autoComplete="email" required />
        </label>
      )}
      <label>
        密码
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={props.bootstrap ? 1 : 12}
          required
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button disabled={pending}>{pending ? '登录中…' : '登录'}</button>
    </form>
  );
}
