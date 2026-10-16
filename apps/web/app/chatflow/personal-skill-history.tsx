'use client';
import { useEffect, useState } from 'react';
import {
  PersonalSkillVersionSchema,
  type PersonalSkillItem,
} from '@allrice/contracts';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';

export function PersonalSkillHistory({
  workspaceId,
  skill,
}: {
  workspaceId: string;
  skill: PersonalSkillItem;
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState('');
  const [versions, setVersions] = useState<
    ReturnType<typeof PersonalSkillVersionSchema.parse>[] | null
  >(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setVersions(null);
    setError('');
    void (async () => {
      const response = await fetch(
        `/api/v1/personal-skills?workspaceId=${encodeURIComponent(workspaceId)}&installationId=${skill.id}`,
        { cache: 'no-store', signal: controller.signal },
      );
      if (!response.ok) throw Error('history');
      const value = await response.json();
      const parsed = PersonalSkillVersionSchema.array().parse(value.versions);
      if (!controller.signal.aborted) setVersions(parsed);
    })().catch(() => {
      if (!controller.signal.aborted)
        setError('历史版本暂时无法读取，请收起后重试。');
    });
    return () => controller.abort();
  }, [open, workspaceId, skill.id, skill.revision]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>版本历史与更新</summary>
      {open && (
        <>
          <p>
            更新或回退会改变这份个人库版本，所有已绑定员工的启停状态保持原样。新任务采用变更；已经开始的任务保留原版本。
          </p>
          <p>
            {skill.source.kind === 'attachment'
              ? '上传来源需要提供新版 SKILL.md / ZIP。'
              : 'GitHub 来源固定到安装时的提交；如需检查新版本，请在聊天中提供要更新的公开链接。'}
            在聊天中明确说明“请将 {skill.name} 更新为……”；AI
            会先展示固定版本和完整影响范围，确认后生效。
          </p>
          {error && <p role="alert">{error}</p>}
          {!versions && !error && <p role="status">正在读取版本历史…</p>}
          {versions?.map((version) => (
            <div key={version.id}>
              <p>
                <strong>
                  v{version.version}
                  {version.current ? ' · 个人库当前版本' : ''}
                </strong>{' '}
                · {new Date(version.createdAt).toLocaleDateString()}
              </p>
              <p>
                来源：
                {version.source.kind === 'github'
                  ? `${version.source.owner}/${version.source.repository} · ${version.source.commitSha.slice(0, 12)}`
                  : version.source.fileName}
              </p>
              {!version.current && skill.state === 'installed' && (
                <>
                  <p>
                    在聊天中发送：请将 {skill.name} 回退到 v{version.version}。
                  </p>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(
                          `请将 ${skill.name} 回退到 v${version.version}。`,
                        )
                        .catch(() =>
                          setError('未能复制，请直接使用上面的回退指令。'),
                        )
                    }
                  >
                    复制回退到 v{version.version} 的指令
                  </Button>
                </>
              )}
            </div>
          ))}
        </>
      )}
    </details>
  );
}
