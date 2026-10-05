'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  QualityScheduleViewSchema,
  type QualityScheduleView,
} from '@allrice/database/technical-contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';
const endpoint = '/api/v1/admin/technical-assistant/quality/schedule';
const reasons: Record<string, string> = {
  QUALITY_DISPATCH_EXPIRED: '已错过派发期限',
  QUALITY_BUSY: '上一轮尚未结束',
  QUALITY_SCHEDULE_CHANGED: '配置已变更',
  QUALITY_SCHEDULE_PAUSED: '规则已暂停',
  QUALITY_SCHEDULE_DELETED: '规则已移除',
  QUALITY_PREPARATION_BLOCKED: '权限或环境受阻',
};
export function PlatformQualitySchedule({
  onSelect,
  onChanged,
}: {
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const [view, setView] = useState<QualityScheduleView | null>(null),
    [time, setTime] = useState('09:00'),
    [writing, setWriting] = useState(false),
    [error, setError] = useState('');
  const mounted = useRef(false),
    sequence = useRef(0),
    busy = useRef(false),
    initialized = useRef(false),
    changed = useRef(onChanged);
  changed.current = onChanged;
  const read = useCallback(async () => {
    const current = ++sequence.current;
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) throw Error('schedule_unavailable');
    const next = QualityScheduleViewSchema.parse(await response.json());
    if (mounted.current && current === sequence.current) {
      setView(next);
      if (!initialized.current) {
        setTime(next.schedule?.time ?? '09:00');
        initialized.current = true;
      }
      changed.current();
    }
    return next;
  }, []);
  useEffect(() => {
    mounted.current = true;
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!busy.current)
        await read().catch(() => {
          if (mounted.current) setError('每日质检配置暂不可读，请刷新核对。');
        });
      if (!stopped)
        timer = setTimeout(() => {
          void poll();
        }, 15000);
    };
    void poll();
    return () => {
      stopped = true;
      mounted.current = false;
      sequence.current++;
      clearTimeout(timer);
    };
  }, [read]);
  async function write(action: 'enable' | 'pause' | 'remove') {
    if (!view || busy.current) return;
    busy.current = true;
    setWriting(true);
    sequence.current++;
    const before = view.schedule;
    const input =
      action === 'remove'
        ? { expectedRevision: before?.revision ?? 0 }
        : {
            expectedRevision: before?.revision ?? 0,
            enabled: action === 'enable',
            time: action === 'pause' ? (before?.time ?? time) : time,
          };
    try {
      const response = await fetch(endpoint, {
        method: action === 'remove' ? 'DELETE' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw Error('schedule_write_unconfirmed');
      QualityScheduleViewSchema.parse(await response.json());
      await read();
      if (mounted.current) setError('');
    } catch {
      // Read the canonical revision before offering another write. No automatic
      // retry can recreate a deleted rule or duplicate an uncertain update.
      const next = await read().catch(() => null);
      const confirmed =
        action === 'remove'
          ? next && !next.schedule
          : next?.schedule &&
            next.schedule.revision > (before?.revision ?? 0) &&
            next.schedule.enabled === (action === 'enable') &&
            next.schedule.time === ('time' in input ? input.time : '');
      if (mounted.current)
        setError(
          confirmed ? '' : '操作结果尚未确认。已回读配置，请核对后再操作。',
        );
    } finally {
      busy.current = false;
      if (mounted.current) setWriting(false);
    }
  }
  return (
    <section className={css.card} aria-label="每日固定场景质检">
      <h3>每日固定场景质检</h3>
      <p className={css.meta}>
        按北京时间检查修正样例。默认关闭，在平台私有测试区执行，不调用模型；错过的日次不会补跑。
      </p>
      <div className={css.controls}>
        <label>
          每日检查时间
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            disabled={writing}
          />
        </label>
        <AdminStatus tone={view?.schedule?.enabled ? 'success' : 'muted'}>
          {!view ? '正在读取' : view.schedule?.enabled ? '已开启' : '未开启'}
        </AdminStatus>
        <AdminButton
          disabled={!view || writing || !time}
          onClick={() => void write('enable')}
        >
          {view?.schedule?.enabled ? '保存每日规则' : '开启每日质检'}
        </AdminButton>
        {view?.schedule && (
          <>
            <AdminButton
              disabled={writing || !view.schedule.enabled}
              onClick={() => void write('pause')}
            >
              暂停每日质检
            </AdminButton>
            <AdminButton
              disabled={writing}
              onClick={() => void write('remove')}
            >
              移除每日规则
            </AdminButton>
          </>
        )}
        <AdminButton
          disabled={writing}
          onClick={() =>
            void read()
              .then(() => setError(''))
              .catch(() => setError('每日质检配置暂不可读。'))
          }
        >
          刷新每日质检
        </AdminButton>
      </div>
      {view?.schedule?.nextRunAt && (
        <p className={css.meta}>
          下次：
          {new Date(view.schedule.nextRunAt).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
          })}{' '}
          · 北京时间
        </p>
      )}
      <p className={css.meta}>
        暂停或移除只停止后续派发；已开始的检查可在质检详情中停止。
      </p>
      {error && <p role="alert">{error}</p>}
      {view?.occurrences.map((o) => (
        <div className={css.record} key={o.id}>
          <span>
            {new Date(o.scheduledFor).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
            })}
          </span>
          <AdminStatus tone={o.accepted ? 'success' : 'muted'}>
            {o.accepted
              ? '质检通过'
              : o.notExecutedReason
                ? `未执行：${reasons[o.notExecutedReason] ?? o.notExecutedReason}`
                : {
                    queued: '排队中',
                    running: '检查中',
                    succeeded: '检查完成',
                    failed: '未完成',
                    canceled: '已停止',
                  }[o.status]}
          </AdminStatus>
          {o.checkId && (
            <AdminButton onClick={() => onSelect(o.checkId!)}>
              查看本轮质检
            </AdminButton>
          )}
        </div>
      ))}
    </section>
  );
}
