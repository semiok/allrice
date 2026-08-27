'use client';

import { useState, type FormEvent } from 'react';

export function AcceptInvitationForm({ token }: { token: string }) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const response = await fetch('/api/v1/auth/invitations/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        displayName: data.get('displayName'),
        password: data.get('password'),
      }),
    });
    if (response.ok) window.location.assign('/chatflow');
    else {
      setError('邀请无效、已使用或已经过期。');
      setPending(false);
    }
  }

  if (!token) return <p role="alert">邀请链接缺少 token。</p>;
  return (
    <form onSubmit={submit} className="auth-form">
      <label>
        姓名
        <input name="displayName" autoComplete="name" required />
      </label>
      <label>
        设置密码（至少 12 位）
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button disabled={pending}>{pending ? '激活中…' : '接受邀请'}</button>
    </form>
  );
}
