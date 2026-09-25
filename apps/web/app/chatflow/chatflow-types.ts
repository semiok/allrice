import type {
  ChatFlowEventEnvelope,
  SaasCapabilityManifest,
  UserQuestionAnswerSubmission,
  ReviewContinuationInput,
  ChangesetActionInput,
  UserPreferences,
} from '@allrice/contracts';

import type { EmployeeProfileDetailsData } from './employee-profile-details';

export type Visibility = 'private' | 'workspace' | 'organization';

export interface Session {
  id: string;
  title: string;
  employeeAssignmentId: string;
  employeeVersionId: string;
  visibility: Visibility;
  updatedAt: string;
  archivedAt: string | null;
  employeeName?: string;
  running?: boolean;
  pendingInteraction?: 'approval' | 'plan-review' | 'question';
}

export interface EmployeeVersion {
  id: string;
  manifest: {
    name: string;
    description?: string;
    runtimePolicy?: {
      harness: 'codex' | 'dsh';
      provider?: string;
      model?: string;
    };
    provider?: { provider: string };
    capabilityBindings?: { toolNames: string[] };
  };
}

export interface Employee {
  id: string;
  employeeId: string;
  isDefault: boolean;
  currentVersion: EmployeeVersion;
  versions: EmployeeVersion[];
}

export interface EmployeeProfile extends EmployeeProfileDetailsData {
  assignmentId: string;
  employeeId: string;
}

export interface Workspace {
  /** Authenticated viewer only; used to isolate local UI preferences. */
  viewerId?: string | null;
  preferences?: UserPreferences;
  organizationId: string;
  workspaceId: string;
  employees: Employee[];
  employeeProfiles: EmployeeProfile[];
  sessions: Session[];
  sessionModels: Array<{
    sessionId: string;
    harness: 'dsh';
    provider: string;
    model: string;
    reasoningEffort: string;
  }>;
  canAdminister: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: {
    budgetWarning?:
      'MODEL_OUTPUT_BUDGET_EXCEEDED' | 'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED';
    text: string;
    interaction?:
      | {
          type: 'user_question_answer';
          answer: UserQuestionAnswerSubmission;
        }
      | { type: 'review_response'; review: ReviewContinuationInput }
      | { type: 'changeset_request'; action: ChangesetActionInput };
  };
  status: 'pending' | 'completed' | 'failed';
  errorCode?: string | null;
  runId: string | null;
  createdAt: string;
  attachments?: Attachment[];
}

export interface QueuedMessage {
  id: string;
  runId: string;
  text: string;
  attachments?: Attachment[];
  createdAt: string;
}

export interface History {
  queuedMessages?: QueuedMessage[];
  session: Session;
  messages: Message[];
  contextStatus: {
    percentage: number;
    pressureTokens: number;
    thresholdTokens: number;
    compactionDue: boolean;
  };
  nativeContextStatus: {
    source: 'dsh';
    usedTokens: number;
    contextWindowTokens: number;
    percentage: number;
    asOfSeq: number | null;
    observedAt: string | null;
  } | null;
}

export interface Attachment {
  id: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  previewUrl?: string;
}

export interface PendingAttachment extends Attachment {
  persistedId: string | null;
  status: 'draft' | 'uploading' | 'ready' | 'failed';
  visibility: Visibility;
  file?: File;
  error?: string;
}

export interface WorkspaceFile extends Attachment {
  visibility: Visibility;
  ownedByMe: boolean;
  category: 'uploads' | 'exports';
  deliverableVersion: number | null;
}

export interface BridgeDevice {
  id: string;
  name: string;
  platform: 'macos-arm64' | 'macos-x64';
  status: 'online' | 'offline' | 'revoked';
  lastSeenAt: string | null;
  folderGrants: Array<{
    id: string;
    label: string;
  }>;
}

export interface RunView {
  runId: string;
  status: 'connecting' | 'running' | 'completed' | 'failed' | 'canceled';
  cursor: string | null;
  reconnects: number;
  events: ChatFlowEventEnvelope[];
}

export interface RunTrace {
  status: 'loading' | 'loaded' | 'failed';
  events: ChatFlowEventEnvelope[];
}

export interface WorkspaceResponse {
  workspace: Workspace;
}

export interface CapabilityResponse {
  capabilities: SaasCapabilityManifest;
}
