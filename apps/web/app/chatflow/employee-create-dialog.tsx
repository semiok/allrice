'use client';
import { useEffect, useRef, useState } from 'react';
import {
  EmployeeInstanceSchema,
  type EmployeeInstance,
} from '@allrice/contracts';
import type { Workspace } from './chatflow-types';
import { DshDialog } from './dsh-upstream/Dialog';
import createCss from './employee-create.module.css';
import {
  EmployeeProfileForm,
  defaultEmployeeProfileFormValues,
  createEmployeeProfile,
  type EmployeeProfileFormValues,
} from './employee-profile-form';
import { readJson } from './chatflow-utils';

export function EmployeeCreateDialog({
  workspace,
  onClose,
  onCreated,
  headers,
}: {
  workspace: Workspace;
  onClose: () => void;
  onCreated: (instance: EmployeeInstance) => void;
  headers: Record<string, string>;
}) {
  const sourceId =
    (workspace.employees.find((e) => e.isDefault) ?? workspace.employees[0])
      ?.id ?? '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ payload: string; id: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function createEmployee(values: EmployeeProfileFormValues) {
    if (active.current || !sourceId || !values.name.trim()) return;
    const profile = createEmployeeProfile(values);
    const payload = JSON.stringify({
      workspaceId: workspace.workspaceId,
      assignmentId: sourceId,
      profile,
    });
    if (request.current?.payload !== payload)
      request.current = { payload, id: crypto.randomUUID() };
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/v1/employee-instances', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          workspaceId: workspace.workspaceId,
          assignmentId: sourceId,
          requestId: request.current.id,
          profile,
        }),
      });
      const result = await readJson<{ instance: EmployeeInstance }>(response);
      if (!controller.signal.aborted)
        onCreated(EmployeeInstanceSchema.parse(result.instance));
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : '创建未完成，请重试。',
        );
    } finally {
      if (!controller.signal.aborted) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <DshDialog
      ariaLabel="创建一位 AI 员工"
      eyebrow="创建员工"
      title="创建一位 AI 员工"
      className={createCss.dialog}
      bodyClassName={createCss.body}
      closeDisabled={busy}
      closeIcon={
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      }
      onClose={() => {
        if (!active.current) onClose();
      }}
      initialFocusSelector="[data-employee-name]"
    >
      <EmployeeProfileForm
        mode="create"
        initialValue={defaultEmployeeProfileFormValues}
        busy={busy}
        disabled={!sourceId}
        error={error}
        onSubmit={createEmployee}
        onCancel={onClose}
      />
    </DshDialog>
  );
}
