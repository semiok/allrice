'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MaintenanceCatalogSchema,
  MaintenanceRegistrationSchema,
  type MaintenanceDeployment,
  type MaintenancePolicy,
} from '@allrice/database/technical-contracts';
import { AdminButton } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';

const endpoint = '/api/v1/admin/technical-assistant/maintenance';
type Catalog = ReturnType<typeof MaintenanceCatalogSchema.parse>;
export function PlatformMaintenance() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companySlug, setCompanySlug] = useState('');
  const [deploymentName, setDeploymentName] = useState('正式部署');
  const [installation, setInstallation] = useState<{
    id: string;
    key: string;
  } | null>(null);
  const pending = useRef<{
    requestId: string;
    companyName: string;
    companySlug: string;
    deploymentName: string;
  } | null>(null);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const seq = ++sequence.current;
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) throw Error('maintenance_read_failed');
    const data = MaintenanceCatalogSchema.parse(await response.json());
    if (seq === sequence.current) setCatalog(data);
    return data;
  }, []);
  useEffect(() => {
    let active = true;
    void load().catch(() => {
      if (active) setError('维护设置暂不可用，请刷新后重试。');
    });
    return () => {
      active = false;
    };
  }, [load]);
  async function register() {
    if (busy) return;
    const input = pending.current ?? {
      requestId: crypto.randomUUID(),
      companyName,
      companySlug,
      deploymentName,
    };
    pending.current = input;
    setBusy(true);
    setError('');
    setInstallation(null);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          pending.current = null;
          setError(
            response.status === 409
              ? '公司部署已存在或登记数量已达上限，请刷新列表核对。'
              : '登记未完成，请检查输入后重试。',
          );
          return;
        }
        throw Error('registration_unconfirmed');
      }
      const result = MaintenanceRegistrationSchema.parse(await response.json());
      if (result.installationKey)
        setInstallation({
          id: result.deployment.id,
          key: result.installationKey,
        });
      pending.current = null;
      sequence.current++;
      setCatalog((prev) => ({
        deployments: [
          result.deployment,
          ...(prev?.deployments ?? []).filter(
            (d) => d.id !== result.deployment.id,
          ),
        ],
        capabilities: prev?.capabilities ?? {
          repairReady: false,
          automaticMerge: false,
          automaticDeployment: false,
          globalRepairConcurrency: 1,
        },
      }));
      setSelected(result.deployment.id);
      setMessage(
        result.installationKey
          ? '公司部署已登记，请保存连接配置。'
          : '已确认原登记。如未保存连接配置，请更换密钥后重新下载。',
      );
      try {
        await load();
      } catch {
        setError('部署已登记，列表暂时未刷新。连接配置仍可下载。');
      }
    } catch {
      setError('登记结果尚未确认，请先刷新列表核对；重试会使用同一个请求。');
    } finally {
      setBusy(false);
    }
  }
  async function credential(action: 'rotate' | 'revoke') {
    if (!deployment || busy) return;
    setBusy(true);
    setError('');
    setInstallation(null);
    try {
      const response = await fetch(`${endpoint}/${deployment.id}/credential`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: deployment.revision, action }),
      });
      if (!response.ok) throw Error('unconfirmed');
      const result = MaintenanceRegistrationSchema.parse(await response.json());
      if (result.installationKey)
        setInstallation({
          id: result.deployment.id,
          key: result.installationKey,
        });
      await load();
      setMessage(
        action === 'revoke'
          ? '部署连接已撤销。'
          : '连接密钥已更换，请重新下载配置。',
      );
    } catch {
      setError('操作结果尚未确认，请刷新核对版本；不要重复更换密钥。');
    } finally {
      setBusy(false);
    }
  }
  function downloadInstallation() {
    if (!installation) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            version: 1,
            centralUrl: window.location.origin,
            deploymentId: installation.id,
            installationKey: installation.key,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = 'allrice-maintenance-connection.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const deployment = catalog?.deployments.find((d) => d.id === selected);
  return (
    <section className={css.card} aria-label="维护设置">
      <h2>维护设置</h2>
      <p className={css.meta}>
        登记独立部署的公司，保存维护偏好和连接凭据。公司部署巡检和修复接通后生效。
      </p>
      <div className={css.controls}>
        <label>
          公司名称
          <input
            aria-label="维护公司名称"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            disabled={busy || !!pending.current}
            maxLength={80}
          />
        </label>
        <label>
          公司英文标识
          <input
            aria-label="维护公司英文标识"
            value={companySlug}
            onChange={(e) => setCompanySlug(e.target.value)}
            disabled={busy || !!pending.current}
            placeholder="company-a"
            maxLength={48}
          />
        </label>
        <label>
          部署名称
          <input
            aria-label="维护部署名称"
            value={deploymentName}
            onChange={(e) => setDeploymentName(e.target.value)}
            disabled={busy || !!pending.current}
            maxLength={80}
          />
        </label>
        <AdminButton
          disabled={
            busy ||
            !companyName.trim() ||
            !/^[a-z][a-z0-9-]{0,47}$/.test(companySlug) ||
            !deploymentName.trim()
          }
          onClick={() => void register()}
        >
          登记公司部署
        </AdminButton>
        <AdminButton
          disabled={busy}
          onClick={() =>
            void load()
              .then(() => setError(''))
              .catch(() => setError('刷新失败，原配置保留。'))
          }
        >
          刷新维护设置
        </AdminButton>
      </div>
      {installation && (
        <p>
          部署已登记。
          <AdminButton onClick={downloadInstallation}>
            下载连接配置
          </AdminButton>{' '}
          请保存此文件，连接密钥仅本次提供。
        </p>
      )}
      {catalog && (
        <label>
          公司部署
          <select
            aria-label="维护公司部署"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setInstallation(null);
            }}
          >
            <option value="">请选择公司部署</option>
            {catalog.deployments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.companyName} · {d.deploymentName}
              </option>
            ))}
          </select>
        </label>
      )}
      {deployment && (
        <>
          <p className={css.meta}>
            连接凭据 v{deployment.credentialRevision} ·{' '}
            {deployment.revokedAt ? '已撤销' : '有效'}
          </p>
          <div className={css.controls}>
            <AdminButton
              disabled={busy}
              onClick={() => void credential('rotate')}
            >
              更换连接密钥
            </AdminButton>
            <AdminButton
              disabled={busy || !!deployment.revokedAt}
              onClick={() => void credential('revoke')}
            >
              撤销部署连接
            </AdminButton>
          </div>
          <MaintenancePolicyEditor
            key={`${deployment.id}:${deployment.revision}`}
            deployment={deployment}
            ready={catalog?.capabilities.repairReady ?? false}
            saved={async () => {
              await load();
              setMessage('配置已保存。');
            }}
          />
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className={css.error}>
          {error}
        </p>
      )}
    </section>
  );
}
function MaintenancePolicyEditor({
  deployment,
  ready,
  saved,
}: {
  deployment: MaintenanceDeployment;
  ready: boolean;
  saved: () => Promise<unknown>;
}) {
  const [policy, setPolicy] = useState<MaintenancePolicy>(deployment.policy);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function save() {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`${endpoint}/${deployment.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: deployment.revision, policy }),
      });
      if (!response.ok)
        throw Error(response.status === 409 ? 'conflict' : 'unconfirmed');
      await saved();
      setMessage('配置已保存。');
    } catch (e) {
      setMessage(
        e instanceof Error && e.message === 'conflict'
          ? '配置已被更新，请刷新后核对再保存。'
          : '保存结果尚未确认，请先刷新核对。',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={css.controls}>
      <label>
        处理方式
        <select
          aria-label="维护处理方式"
          value={policy.mode}
          disabled={busy}
          onChange={(e) =>
            setPolicy({
              ...policy,
              mode: e.target.value as MaintenancePolicy['mode'],
            })
          }
        >
          <option value="report_only">仅检查报告</option>
          <option value="repair_and_pr" disabled={!ready}>
            修复并提交 PR{!ready ? '（接入中）' : ''}
          </option>
        </select>
      </label>
      <label>
        检查间隔（分钟，接入后生效）
        <input
          aria-label="维护检查间隔"
          type="number"
          min={15}
          max={10080}
          value={policy.checkIntervalMinutes}
          disabled={busy}
          onChange={(e) =>
            setPolicy({
              ...policy,
              checkIntervalMinutes: Number(e.target.value),
            })
          }
        />
      </label>
      <label>
        单次修复上限（分钟）
        <input
          aria-label="维护修复时长"
          type="number"
          min={5}
          max={120}
          value={policy.repairTimeoutMinutes}
          disabled={busy}
          onChange={(e) =>
            setPolicy({
              ...policy,
              repairTimeoutMinutes: Number(e.target.value),
            })
          }
        />
      </label>
      <label>
        <input
          aria-label="暂停维护任务"
          type="checkbox"
          checked={policy.paused}
          disabled={busy}
          onChange={(e) => setPolicy({ ...policy, paused: e.target.checked })}
        />
        暂停新的维护任务
      </label>
      <AdminButton disabled={busy} onClick={() => void save()}>
        {busy ? '保存中…' : '保存维护设置'}
      </AdminButton>
      <p className={css.meta}>
        {!ready && '公司部署巡检与修复尚未接通，当前仅保存配置。'}{' '}
        自动合并和自动部署关闭；历史报告与 PR 保留。
      </p>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
