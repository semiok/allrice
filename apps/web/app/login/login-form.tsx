'use client';

import { useState, type FormEvent } from 'react';

export function LoginForm() {
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
        email: data.get('email'),
        password: data.get('password'),
      }),
    });
    if (response.ok) window.location.assign('/');
    else {
      setError('登录失败，请检查邮箱、密码或账号状态。');
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="auth-form">
      <label>
        邮箱
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        密码
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={12}
          required
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button disabled={pending}>{pending ? '登录中…' : '登录'}</button>
    </form>
  );
}
