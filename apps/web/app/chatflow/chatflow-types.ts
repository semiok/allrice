import type {
  ChatFlowEventEnvelope,
  SaasCapabilityManifest,
  UserQuestionAnswerSubmission,
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
    text: string;
    interaction?: {
      type: 'user_question_answer';
      answer: UserQuestionAnswerSubmission;
    };
  };
  status: 'pending' | 'completed' | 'failed';
  runId: string | null;
  createdAt: string;
  attachments?: Attachment[];
}

export interface History {
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
