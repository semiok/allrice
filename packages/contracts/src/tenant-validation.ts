import type { AdminTenantEnvironments } from './tenant-environments.ts';
import type { AdminTenantQuotas } from './tenant-quotas.ts';
import type { WorkbenchArtifact } from './runtime-v2/artifact-review.ts';
import type { RuntimeRunUsage } from './runtime-run-usage.ts';

export interface TenantValidationSummary {
  organizationId: string;
  workspaceId: string;
  subjectId: string;
  inspectorId: string;
  deviceId: string | null;
  observedAt: string;
  policyVersion: number | null;
  assignments: {
    id: string;
    name: string;
    versionId: string;
    version: number;
    isDefault: boolean;
  }[];
  environments: AdminTenantEnvironments;
  quotas: AdminTenantQuotas | null;
  quotaError: boolean;
  runs: {
    id: string;
    sessionId: string;
    title: string;
    status: string;
    createdAt: string;
    employeeVersionId: string;
  }[];
  runsTruncated: boolean;
}
export interface TenantRunInspection {
  organizationId: string;
  workspaceId: string;
  subjectId: string;
  inspectorId: string;
  run: {
    id: string;
    sessionId: string;
    status: string;
    employeeVersionId: string;
    createdAt: string;
  };
  userText: string | null;
  answerText: string | null;
  usage: RuntimeRunUsage | null;
  events: {
    key: string;
    title: string;
    status: string;
    detail: string | null;
  }[];
  operations: {
    id: string;
    deviceId: string | null;
    targetId: string;
    action: string;
    status: string;
    approval: string | null;
    expiresAt: string | null;
    output: string;
    outputTruncated: boolean;
  }[];
  operationsTruncated: boolean;
  artifacts: WorkbenchArtifact[];
  artifactsTruncated: boolean;
  development?: TenantDevelopmentInspection | null;
}

/** Read-only provenance, never a command approval or a new execution grant. */
export interface TenantDevelopmentInspection {
  candidateId: string;
  digest: string;
  revision: number;
  proposals: {
    artifactId: string;
    authorRunId: string;
    digest: string;
    accepted: boolean;
  }[];
  tests: {
    operationId: string;
    testerRunId: string;
    candidateId: string;
    digest: string;
    status: string;
    evidenceMatched: boolean;
    exitCode: number | null;
    reason: string | null;
  }[];
  reviews: {
    id: string;
    reviewerRunId: string;
    candidateId: string;
    digest: string;
    operationId: string;
    verdict: 'accept' | 'revise';
    summary: string;
  }[];
  deliveries: {
    artifactId: string;
    candidateId: string;
    digest: string;
    reviewId: string;
  }[];
  truncated: boolean;
}
