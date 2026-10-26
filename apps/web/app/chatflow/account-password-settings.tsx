'use client';

import { useState, type FormEvent } from 'react';
import {
  Button,
  DisclosureRow,
  IconShieldOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import styles from './sidebar-settings.module.css';

export function AccountPasswordSettings() {
  const [open, setOpen] = useState(false);
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
            : '密码没有改成，请稍后再试。',
        );
        return;
      }
      window.location.assign('/login');
    } catch {
      setError('暂时连不上服务，密码没有改成，请稍后再试。');
    } finally {
      setPending(false);
    }
  }
  return (
    <div className={styles.settingsFold}>
      <DisclosureRow
        icon={<IconShieldOutlineRegular size={14} />}
        title="修改登录密码"
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen((value) => !value)}
        titleClassName={styles.settingsFoldTitle}
      >
        {open && (
          <div className={styles.settingsFoldBody}>
            <p>修改后，请在各设备上使用新密码重新登录。</p>
            <form className={styles.passwordForm} onSubmit={submit}>
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
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={pending}
              >
                {pending ? '正在保存…' : '修改密码并重新登录'}
              </Button>
            </form>
          </div>
        )}
      </DisclosureRow>
    </div>
  );
}
