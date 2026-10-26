'use client';

import { useState, type ChangeEvent, type FormEvent } from 'react';
import {
  Button,
  DisclosureRow,
  IconShieldOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import styles from './sidebar-settings.module.css';

// The server may have changed the password and ended this session before the
// reply was lost; never claim it was not changed.
const resultUnknown = '修改结果待确认，请重新登录，确认新密码是否生效。';
const empty = { currentPassword: '', newPassword: '', confirmPassword: '' };

export function AccountPasswordSettings() {
  const [open, setOpen] = useState(false);
  // Kept here so folding the section does not clear what was typed.
  const [values, setValues] = useState(empty);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const field = (name: keyof typeof empty) => ({
    name,
    value: values[name],
    onChange: (event: ChangeEvent<HTMLInputElement>) =>
      setValues((current) => ({ ...current, [name]: event.target.value })),
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (values.newPassword !== values.confirmPassword) {
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
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        }),
      });
      if (!response.ok) {
        setError(
          response.status === 401
            ? '当前密码不正确，或登录已过期。'
            : response.status < 500
              ? '密码没有改成，请检查填写的内容后再试。'
              : resultUnknown,
        );
        return;
      }
      window.location.assign('/login');
    } catch {
      setError(resultUnknown);
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
                  {...field('currentPassword')}
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              <label>
                新密码
                <input
                  {...field('newPassword')}
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
                  {...field('confirmPassword')}
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
