'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PersonalSkillItemSchema,
  type PersonalSkillItem,
} from '@allrice/contracts';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import styles from './personal-skills-settings.module.css';

export function PersonalSkillsSettings({
  workspaceId,
  active,
}: {
  workspaceId: string;
  active: boolean;
}) {
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  const [data, setData] = useState<{ skills: PersonalSkillItem[] } | null>(
    null,
  );
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(false);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(
        `/api/v1/personal-skills?workspaceId=${encodeURIComponent(workspaceId)}`,
        { signal, cache: 'no-store' },
      );
      if (!response.ok) throw Error('个人技能暂时无法读取，请重试。');
      const value = await response.json();
      if (!signal?.aborted && currentWorkspace.current === workspaceId)
        setData({
          skills: PersonalSkillItemSchema.array().parse(value.skills),
        });
    },
    [workspaceId],
  );
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    setError('');
    void load(abort.signal).catch(() => {
      if (!abort.signal.aborted) setError('个人技能暂时无法读取，请重试。');
    });
    return () => abort.abort();
  }, [active, load]);
  useEffect(() => {
    setData(null);
    setNotice('');
    setError('');
  }, [workspaceId]);
  async function change(
    skill: PersonalSkillItem,
    instanceId: string | undefined,
    operation: 'enable' | 'disable' | 'uninstall',
  ) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/v1/personal-skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          instanceId,
          installationId: skill.id,
          expectedRevision: skill.revision,
          requestId: crypto.randomUUID(),
          operation,
        }),
      });
      if (!response.ok)
        throw Error('技能状态或权限已变化，请查看刷新后的状态。');
      if (currentWorkspace.current !== workspaceId) return;
      setNotice(
        operation === 'uninstall'
          ? '已卸载，历史安装版本保留。'
          : operation === 'disable'
            ? '已停用，后续任务不再使用这个技能。'
            : '已启用，下一个任务可采用。',
      );
    } catch {
      if (currentWorkspace.current === workspaceId)
        setError('操作结果需要核对，已重新读取技能状态。请查看后再操作。');
    } finally {
      try {
        await load();
      } catch {
        if (currentWorkspace.current === workspaceId)
          setError('暂时无法核对技能状态，请刷新后再操作。');
      }
      setPending(false);
    }
  }
  return (
    <div className={styles.root}>
      <p>
        在与 AI 员工的聊天中上传一份 SKILL.md，再说“请安装我上传的
        SKILL.md”。技能只为你安装，并绑定当时的 AI
        员工；不会改变公司的共享内容。
      </p>
      <p>安装时检查文件格式。是否适合你的业务，需要通过实际任务试用。</p>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => {
          setError('');
          void load().catch(() => setError('读取失败，请重试。'));
        }}
      >
        刷新技能
      </Button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!data && !error && <p role="status">正在读取个人技能…</p>}
      {data?.skills.length === 0 && <p>还没有安装个人技能。</p>}
      {data?.skills.map((skill) => (
        <article className={styles.skill} key={skill.id}>
          <h3>
            {skill.name}{' '}
            <span>
              v{skill.version} ·{' '}
              {skill.state === 'installed' ? '已安装' : '已卸载'}
            </span>
          </h3>
          <p>{skill.description}</p>
          <p className={styles.meta}>
            来源：{skill.source.fileName} · 格式已检查 · 业务效果尚未验证
          </p>
          {skill.bindings.map((binding) => {
            return (
              <div className={styles.binding} key={binding.id}>
                <span>
                  {binding.label} ·{' '}
                  {binding.enabled && skill.state === 'installed'
                    ? '已启用'
                    : '已停用'}
                </span>
                {skill.state === 'installed' && (
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      void change(
                        skill,
                        binding.instanceId,
                        binding.enabled ? 'disable' : 'enable',
                      )
                    }
                  >
                    {binding.enabled ? '停用' : '启用'}
                  </Button>
                )}
              </div>
            );
          })}
          {skill.state === 'installed' && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void change(skill, undefined, 'uninstall')}
            >
              卸载个人技能
            </Button>
          )}
          {!skill.bindings.length && (
            <p className={styles.meta}>
              当前工作区没有可用绑定；原始安装记录保留。
            </p>
          )}
        </article>
      ))}
    </div>
  );
}
