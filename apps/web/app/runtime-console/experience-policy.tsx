'use client';
import { useState } from 'react';
import {
  ExperienceCollectionPolicySchema,
  experiencePolicySchedule,
} from '@allrice/contracts';
import { AdminButton } from '../../components/admin/admin-ui';
import css from './organization-ai-directory.module.css';
type Settings = ReturnType<typeof experiencePolicySchedule>;
export function ExperiencePolicyPanel({
  organizationId,
}: {
  organizationId: string;
}) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [validationMode, setValidationMode] = useState<
    'off' | 'supported_cases'
  >('off');
  const [adoptionMode, setAdoptionMode] = useState<'off' | 'supported_private'>(
    'off',
  );
  const url = `/api/v1/admin/organizations/${organizationId}/experience-policy`;
  async function load() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw Error('读取经验整理设置失败');
      const policy = ExperienceCollectionPolicySchema.parse(
        (await response.json()).policy,
      );
      setSettings(experiencePolicySchedule(policy));
      setRevision(policy.revision);
      setAdoptionMode(policy.schemaVersion === 4 ? policy.adoptionMode : 'off');
      setValidationMode(
        'validationMode' in policy ? policy.validationMode : 'off',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!settings) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...settings,
          validationMode,
          adoptionMode,
          expectedRevision: revision,
        }),
      });
      if (!response.ok) {
        if (response.status === 503) {
          const refusal: unknown = await response.json().catch(() => null);
          if (
            typeof refusal === 'object' &&
            refusal !== null &&
            'code' in refusal &&
            refusal.code === 'EXPERIENCE_SCHEDULING_UNAVAILABLE'
          )
            throw Error('经验自动整理暂不可用，本次设置未保存；仍可关闭整理。');
        }
        throw Error(
          response.status === 409
            ? '设置已变化，请重新读取。'
            : '未确认保存结果，请重新读取后核对。',
        );
      }
      const policy = ExperienceCollectionPolicySchema.parse(
        (await response.json()).policy,
      );
      setSettings(experiencePolicySchedule(policy));
      setRevision(policy.revision);
      setAdoptionMode(policy.schemaVersion === 4 ? policy.adoptionMode : 'off');
      setValidationMode(
        'validationMode' in policy ? policy.validationMode : 'off',
      );
      setNotice(
        policy.frequency === 'off'
          ? '已关闭自动整理。已生成的草稿和历史记录保留。'
          : '已保存。整理按下一周期执行，不补跑错过周期；开启专项验证后，也会检查已有待验证草稿。',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !settings && !busy) void load();
      }}
    >
      <summary>经验自动整理设置</summary>
      <p className={css.note}>
        适用于本公司的 AI
        员工。只整理各自新增的私有反馈，先形成待验证草稿；开启自动采用后也仅用于原私人
        AI 员工，不自动共享或改变公司要求。
      </p>
      {settings && (
        <div className={css.filters}>
          <label>
            整理频率
            <select
              aria-label="整理频率"
              disabled={busy}
              value={settings.frequency}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  frequency: e.target.value as Settings['frequency'],
                })
              }
            >
              <option value="off">关闭</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
          </label>
          {settings.frequency !== 'off' && (
            <>
              <label>
                时区
                <input
                  aria-label="时区"
                  disabled={busy}
                  value={settings.timezone}
                  onChange={(e) =>
                    setSettings({ ...settings, timezone: e.target.value })
                  }
                />
              </label>
              <label>
                整理时间
                <input
                  disabled={busy}
                  aria-label="整理时间"
                  type="time"
                  value={settings.time}
                  onChange={(e) =>
                    setSettings({ ...settings, time: e.target.value })
                  }
                />
              </label>
              {settings.frequency === 'weekly' && (
                <label>
                  每周
                  <select
                    aria-label="每周"
                    disabled={busy}
                    value={settings.weekday}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        weekday: Number(e.target.value),
                      })
                    }
                  >
                    {['日', '一', '二', '三', '四', '五', '六'].map(
                      (day, i) => (
                        <option key={i} value={i}>
                          星期{day}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              )}
              {settings.frequency === 'monthly' && (
                <label>
                  每月日期
                  <input
                    disabled={busy}
                    aria-label="每月日期"
                    type="number"
                    min={1}
                    max={31}
                    value={settings.monthDay}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        monthDay: Number(e.target.value),
                      })
                    }
                  />
                </label>
              )}
            </>
          )}
          <label>
            <input
              type="checkbox"
              aria-label="自动专项验证"
              disabled={busy}
              checked={validationMode === 'supported_cases'}
              onChange={(e) =>
                setValidationMode(e.target.checked ? 'supported_cases' : 'off')
              }
            />
            自动验证支持的合成样例（消耗模型用量）
          </label>
          <label>
            <input
              type="checkbox"
              aria-label="自动采用已验证的私人经验"
              disabled={busy}
              checked={adoptionMode === 'supported_private'}
              onChange={(e) =>
                setAdoptionMode(e.target.checked ? 'supported_private' : 'off')
              }
            />
            自动采用已验证的私人经验
          </label>
          <AdminButton disabled={busy} onClick={() => void save()}>
            保存整理设置
          </AdminButton>
          <AdminButton disabled={busy} onClick={() => void load()}>
            重新读取
          </AdminButton>
        </div>
      )}
      <p className={css.note}>
        整理没有新增反馈时不会调用模型。每次最多 16 条，最多 5 分钟；每人每个 AI
        员工每天最多整理一次。本公司每天最多 8 次，平台每天最多 64
        次，后台最多同时执行 1
        次，并为聊天保留执行空位。每月日期超出当月天数时按月底执行。
      </p>
      <p className={css.note}>
        专项验证默认关闭。开启后每份支持的草稿最多验证一次，单次最多 5
        分钟；验证另限本公司每天 8 次、平台每天 64
        次，与整理共用一个后台执行空位。自动采用默认关闭；开启后，仅完整规则和适用范围均受支持、验证依据仍有效的私人经验生效。关闭整理或自动采用只停止新增，不删除已有经验。用户可在聊天中明确撤回。不支持的业务仍待验证。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
