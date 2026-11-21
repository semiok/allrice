import type { ComponentProps } from 'react';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots';
import type { EnterpriseMaterialsPanel } from '../../../apps/web/app/chatflow/enterprise-materials-panel';
import type { WorkbenchFilesPanel } from '../../../apps/web/app/chatflow/workbench-files-panel';
import type { EmployeeMemorySidebar } from '../../../apps/web/app/chatflow/employee-memory-sidebar';
import type { EmployeeCapabilitiesPanel } from '../../../apps/web/app/chatflow/employee-capabilities-panel';

type Materials = ComponentProps<typeof EnterpriseMaterialsPanel>;
type Files = ComponentProps<typeof WorkbenchFilesPanel>;
type Memory = ComponentProps<typeof EmployeeMemorySidebar>;
type Capabilities = ComponentProps<typeof EmployeeCapabilitiesPanel>;

/** Existing server-authorized selection/revision; never a filesystem path. */
export type EmployeePanelsReference =
  Parameters<Materials['onUse']>[0] | Parameters<Files['onUse']>[0];

export interface EmployeePanelsActions {
  /** Resolver belongs to the authenticated capability owner. It must return
   * an actual native main registration, not a URL or management fallback. */
  openMain(
    resolve: (
      signal: AbortSignal,
    ) => MainPanelId | null | Promise<MainPanelId | null>,
  ): Promise<void>;
  readonly signal: AbortSignal;
}

/** UI props only. Business schemas, requests, permissions and writes retain
 * their original owners. The capability owner composes the real sections. */
export interface EmployeePanelsSnapshot {
  /** Changes when the authenticated UI target or authority revision changes.
   * This is a lifecycle key, never an authorization assertion. */
  readonly scopeKey: string;
  /** Existing files-unread semantics. null means unknown, not successful zero. */
  readonly filesUnread: number | null;
  readonly materials: Omit<Materials, 'active' | 'onUse'>;
  readonly files: Omit<Files, 'active' | 'onUse'>;
  readonly experience: Omit<Memory, 'active'>;
  /** Pure props composition. Existing controllers/providers remain in the
   * authenticated owner; do not create hooks or a second catalog here. */
  readonly workflow: (
    actions: EmployeePanelsActions,
  ) => Omit<Capabilities, 'active'>;
}

export interface EmployeePanelsPort {
  /** Stable snapshot identity until the owner publishes a change. null means
   * unavailable; there is no fixture/default empty-success snapshot. */
  getSnapshot(sessionId: SessionIdOf): EmployeePanelsSnapshot | null;
  subscribe(sessionId: SessionIdOf, listener: () => void): () => void;
  /** Actual scoped native-reference insertion bridge. true means the native
   * input accepted this precise selection; false/throw is failure. The owner
   * supplies current Session/span guards and submit-time reference resolution.
   * This callback does not grant resource access or prove model consumption. */
  useReference?: (request: {
    sessionId: SessionIdOf;
    scopeKey: string;
    reference: EmployeePanelsReference;
    signal: AbortSignal;
  }) => boolean;
}

export interface EmployeePanelsBinding {
  readonly port: EmployeePanelsPort;
  readonly signal: AbortSignal;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    allriceEmployeePanels: EmployeePanelsBinding;
  }
}
