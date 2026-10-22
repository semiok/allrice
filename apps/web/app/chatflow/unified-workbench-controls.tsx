'use client';
import { useEffect, useRef, type Ref } from 'react';
import { useBrandContentWorkspace } from './use-brand-content-workspace';
import {
  WorkbenchEntries,
  useWorkbenchDirectory,
  useWorkbenchUnread,
  type WorkbenchModule,
} from './workbench-modules';
export const workbenchReadEvent = 'allrice:workbench-module-read';
export function announceWorkbenchRead(scope: string, kind: WorkbenchModule) {
  window.dispatchEvent(
    new CustomEvent(workbenchReadEvent, { detail: { scope, kind } }),
  );
}
export function UnifiedWorkbenchControls(props: {
  scope: string;
  scopeId: string;
  workspaceId: string;
  viewerId?: string | null;
  instanceId?: string;
  kind?: 'general' | 'custom';
  headers: Record<string, string>;
  refreshKey: string;
  open: boolean;
  selected?: WorkbenchModule | 'schedule' | null;
  schedule?: boolean;
  onSchedule?: () => void;
  onOpen: (kind: WorkbenchModule) => void;
  onToggle: () => void;
  entryRef?: Ref<HTMLButtonElement>;
  onCapabilities: (value: { scope: string; workflow: boolean }) => void;
}) {
  const directory = useWorkbenchDirectory({
    enabled: true,
    workspaceId: props.workspaceId,
    instanceId: props.instanceId,
    scope: props.scope,
    headers: props.headers,
    refreshKey: props.refreshKey,
  });
  const workflow = useBrandContentWorkspace(props);
  const files = useWorkbenchUnread(props.scopeId + '/files', directory.fileIds);
  const experience = useWorkbenchUnread(
    props.scope + '/experience',
    directory.experienceIds,
  );
  const flows = useWorkbenchUnread(
    props.scope + '/workflow',
    workflow.available ? workflow.keys : null,
  );
  const marks = useRef({
    files: files.markRead,
    experience: experience.markRead,
    workflow: flows.markRead,
  });
  marks.current = {
    files: files.markRead,
    experience: experience.markRead,
    workflow: flows.markRead,
  };
  const changed = useRef(props.onCapabilities);
  changed.current = props.onCapabilities;
  useEffect(() => {
    changed.current({ scope: props.scope, workflow: workflow.available });
  }, [props.scope, workflow.available]);
  useEffect(() => {
    const read = (event: Event) => {
      const detail = (
        event as CustomEvent<{ scope: string; kind: WorkbenchModule }>
      ).detail;
      if (detail?.scope === props.scope) marks.current[detail.kind]?.();
    };
    window.addEventListener(workbenchReadEvent, read);
    return () => window.removeEventListener(workbenchReadEvent, read);
  }, [props.scope]);
  return (
    <WorkbenchEntries
      counts={{
        files: files.count,
        experience: experience.count,
        workflow: flows.count,
      }}
      experience={!!props.instanceId}
      workflow={workflow.available}
      open={props.open}
      selected={props.selected}
      schedule={props.schedule}
      onSchedule={props.onSchedule}
      onOpen={(kind) => {
        marks.current[kind]();
        props.onOpen(kind);
      }}
      onToggle={props.onToggle}
      entryRef={props.entryRef}
    />
  );
}
