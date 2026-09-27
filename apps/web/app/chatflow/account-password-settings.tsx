'use client';

import { useState, type FormEvent } from 'react';

export function AccountPasswordSettings() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (data.get('newPassword') !== data.get('confirmPassword')) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/v1/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          currentPassword: data.get('currentPassword'),
          newPassword: data.get('newPassword'),
        }),
      });
      if (!response.ok) {
        setError(
          response.status === 401
            ? '当前密码不正确，或登录已过期。'
            : '修改失败，请稍后重试。',
        );
        return;
      }
      window.location.assign('/login');
    } catch {
      setError('暂时无法连接，请稍后重试。');
    } finally {
      setPending(false);
    }
  }
  return (
    <details>
      <summary>修改登录密码</summary>
      <p>修改后，请在各设备上使用新密码重新登录。</p>
      <form className="auth-form" onSubmit={submit}>
        <label>
          当前密码
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          新密码
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={256}
            required
          />
        </label>
        <label>
          确认新密码
          <input
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={256}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button disabled={pending}>
          {pending ? '保存中…' : '修改密码并重新登录'}
        </button>
      </form>
    </details>
  );
}
