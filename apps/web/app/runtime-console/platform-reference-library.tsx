'use client';

import { useState } from 'react';
import { z } from 'zod';
import { AdminButton } from '../../components/admin/admin-ui';
import { workbenchJson } from '../../lib/chatflow/workbench-model';
import { ReferenceLibrary } from '../chatflow/reference-library';

const headers = {};
export function PlatformReferenceLibrary() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function open() {
    setBusy(true);
    setError('');
    try {
      const value = z
        .object({
          options: z.object({
            workspaceId: z.string().uuid(),
            platformMaintainer: z.literal(true),
          }),
        })
        .parse(await workbenchJson('/api/v1/references', headers));
      setWorkspaceId(value.options.workspaceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '资料读取失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <p>
        平台参考资料由平台统一维护，公司员工可查看和下载。这里的资料库由所有 AI
        员工共用。
      </p>
      <AdminButton disabled={busy} onClick={() => void open()}>
        管理平台参考资料
      </AdminButton>
      {error && <p role="alert">{error}</p>}
      {workspaceId && (
        <ReferenceLibrary
          workspaceId={workspaceId}
          headers={headers}
          platform
          onClose={() => setWorkspaceId(null)}
        />
      )}
    </div>
  );
}
