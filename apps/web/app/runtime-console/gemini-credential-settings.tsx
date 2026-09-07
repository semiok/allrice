'use client';

import { useEffect, useState } from 'react';
import styles from './employee-production.module.css';

interface CredentialStatus {
  configured: boolean;
  writable: boolean;
  updatedAt: string | null;
}
const endpoint = '/api/v1/admin/providers/gemini/credential';

export function GeminiCredentialSettings({
  credentialReference,
}: {
  credentialReference: string;
}) {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  const usesDefault = credentialReference === 'deployment:gemini-default';

  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    setError('');
    fetch(endpoint, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error?.message ?? '无法读取密钥配置状态。');
        if (!controller.signal.aborted) setStatus(body.credential);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            '无法读取密钥状态，请确认管理员登录和服务端凭证配置后重试。',
          );
      });
    return () => controller.abort();
  }, [refresh]);

  async function save() {
    if (busy || !apiKey.trim() || !status?.writable || !usesDefault) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error?.message ?? '保存失败，请刷新后重试。');
      setStatus(body.credential);
      setMessage(
        body.auditRecorded === false
          ? '密钥已保存；审计请求已记录，但结果记录暂未完成，请管理员检查。'
          : '密钥已保存，尚未验证真实 API 调用。不会自动启用或发布员工。',
      );
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : '保存失败，请刷新后重试。',
      );
    } finally {
      setApiKey('');
      setBusy(false);
    }
  }

  return (
    <section
      className={`${styles.credentialPanel} ${styles.fieldWide}`}
      aria-label="Gemini API 密钥配置"
    >
      <div className={styles.credentialHeader}>
        <h3>Gemini API Key</h3>
        <span
          className={
            status?.configured ? styles.credentialConfigured : styles.muted
          }
        >
          {status
            ? status.configured
              ? '已配置'
              : '未配置'
            : error
              ? '状态未知'
              : '正在读取…'}
        </span>
      </div>
      <p className={styles.muted}>
        平台共用密钥，仅管理员可修改。密钥只保存在服务端，保存后不回显；留空不修改。
      </p>
      {!usesDefault ? (
        <p role="alert" className={styles.credentialError}>
          此草稿使用自定义凭证引用，不能在这里修改平台默认密钥。请先明确该凭证的配置范围。
        </p>
      ) : null}
      <label className={styles.field}>
        <span>API Key</span>
        <input
          type="password"
          aria-label="Gemini API Key"
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={256}
          value={apiKey}
          disabled={busy || !status?.writable || !usesDefault}
          placeholder={
            status?.configured
              ? '已保存；如需替换，请输入新密钥'
              : '粘贴你的 Gemini API Key'
          }
          onChange={(event) => {
            setApiKey(event.target.value);
            setMessage('');
          }}
        />
      </label>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          onClick={save}
          disabled={busy || !apiKey.trim() || !status?.writable || !usesDefault}
        >
          {busy
            ? '正在保存…'
            : status?.configured
              ? '保存并替换 API Key'
              : '保存 API Key'}
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          onClick={() => {
            setMessage('');
            setRefresh((value) => value + 1);
          }}
        >
          刷新配置状态
        </button>
      </div>
      {status?.updatedAt ? (
        <p className={styles.muted}>
          最近保存：{new Date(status.updatedAt).toLocaleString('zh-CN')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.credentialError}>
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className={styles.muted}>
          {message}
        </p>
      ) : null}
      <p className={styles.muted}>
        “已配置”不代表 API
        已验证可用；执行开关、模型治理和员工发布仍需单独通过。
      </p>
      <details className={styles.muted}>
        <summary>密钥使用范围</summary>
        <p>
          不写入员工草稿、聊天或模型上下文。替换会影响后续使用此凭证创建的
          Gemini Runtime，已启动的 Runtime 不会自动换钥。
        </p>
      </details>
    </section>
  );
}
