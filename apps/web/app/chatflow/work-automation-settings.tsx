'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  WorkAutomationViewSchema,
  type WorkAutomation,
} from '@allrice/contracts';
import type { z } from 'zod';
import styles from './sidebar-settings.module.css';

const choices = [
  {
    key: 'cloud',
    title: '云端自动工作',
    description:
      '在已授权范围内处理文档、计算、浏览网页和使用已连接应用。关闭后，执行操作会逐次向你确认。',
  },
  {
    key: 'computer',
    title: '我的电脑自动工作',
    description:
      '在已选择的文件夹和 Bridge 环境内直接执行。关闭后，写文件、运行命令和浏览器操作会逐次向你确认。',
  },
  {
    key: 'assistants',
    title: '自动安排助手',
    description: '允许当前员工按需安排助手协作。关闭后，由当前员工独立处理。',
  },
] as const;
type View = z.infer<typeof WorkAutomationViewSchema>;

export function WorkAutomationSettings({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<keyof WorkAutomation | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const endpoint = `/api/v1/me/work-automation?workspaceId=${encodeURIComponent(workspaceId)}`;
  useEffect(() => {
    const controller = new AbortController();
    ++generation.current;
    setView(null);
    setBusy(null);
    setError('');
    void fetch(endpoint, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw Error(body.error?.message ?? '暂时无法读取工作方式。');
        const value = WorkAutomationViewSchema.parse(body);
        if (value.workspaceId !== workspaceId)
          throw Error('工作区已变化，请重新打开设置。');
        if (!controller.signal.aborted) setView(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '读取失败');
      });
    return () => {
      controller.abort();
      ++generation.current;
    };
  }, [endpoint, workspaceId, revision]);
  async function toggle(capability: keyof WorkAutomation, enabled: boolean) {
    if (!view || busy || !view.editable) return;
    const requestGeneration = generation.current;
    setBusy(capability);
    setError('');
    try {
      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: view.revision,
          capability,
          enabled,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw Error(body.error?.message ?? '设置未保存，请刷新后重试。');
      const value = WorkAutomationViewSchema.parse(body);
      if (value.workspaceId !== workspaceId) throw Error('工作区已变化。');
      if (generation.current === requestGeneration) setView(value);
    } catch (cause) {
      if (generation.current === requestGeneration)
        setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      if (generation.current === requestGeneration) setBusy(null);
    }
  }
  return (
    <section aria-label="员工工作方式设置">
      <p>
        在你的员工、应用和电脑已授权范围内自动执行。需要新账号、新文件夹或扩大范围时，再向你申请。
      </p>
      {error ? (
        <p role="alert">
          {error}{' '}
          <Button
            variant="outline"
            onClick={() => setRevision((value) => value + 1)}
          >
            重新读取
          </Button>
        </p>
      ) : null}
      {!view && !error ? <p role="status">正在读取工作方式…</p> : null}
      {view ? (
        <>
          {!view.editable ? (
            <p>只读成员可以查看设置；当前身份不能发起执行。</p>
          ) : null}
          {choices.map((choice) => (
            <div key={choice.key} className={styles.capabilitySetting}>
              <div>
                <strong>{choice.title}</strong>
                <p>{choice.description}</p>
                <small>
                  {busy === choice.key
                    ? '正在保存…'
                    : view.settings[choice.key]
                      ? '已开启'
                      : choice.key === 'assistants'
                        ? '独立工作'
                        : '每次确认'}
                </small>
              </div>
              <Switch
                label={choice.title}
                checked={view.settings[choice.key]}
                disabled={busy !== null || !view.editable}
                onChange={(enabled) => void toggle(choice.key, enabled)}
              />
            </div>
          ))}
          <p>
            对后续发起的操作生效。已发起的操作继续按当时的授权处理；可在任务中停止。电脑是否可用由「我的电脑」中的能力开关控制。
          </p>
        </>
      ) : null}
    </section>
  );
}
