'use client';

import { useRef } from 'react';
import { EmployeeMemoryManager } from './employee-memory-manager';
import type { MemoryWriteStore } from '../../lib/memory/employee-memory-client';
import css from './workbench-experience-panel.module.css';

/** The retained dock kind hosts current employee memory only. */
export function WorkbenchExperiencePanel(props: {
  scopeId: string;
  workspaceId: string;
  employees: Array<{ id: string; name: string }>;
  headers: Record<string, string>;
  active: boolean;
  memoryRequest: { instanceId: string; revision: number };
  memoryWrites?: MemoryWriteStore;
}) {
  const localMemoryWrites = useRef<MemoryWriteStore>(new Map());
  return (
    <section
      className={css.panel}
      aria-label="记忆"
      hidden={!props.active}
      style={!props.active ? { display: 'none' } : undefined}
    >
      <div className={css.body} style={{ padding: 0, overflow: 'hidden' }}>
        <EmployeeMemoryManager
          key={`${props.scopeId}/${props.workspaceId}/${props.memoryRequest.instanceId}`}
          scopeId={props.scopeId}
          workspaceId={props.workspaceId}
          instanceId={props.memoryRequest.instanceId}
          employeeName={
            props.employees.find(
              (item) => item.id === props.memoryRequest.instanceId,
            )?.name
          }
          headers={props.headers}
          writes={props.memoryWrites ?? localMemoryWrites.current}
          active={props.active}
        />
      </div>
    </section>
  );
}
