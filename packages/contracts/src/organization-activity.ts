import type {
  ManagedOrganization,
  OrganizationPerson,
} from './organization-administration.ts';
import type { TaskRuntimeTiming } from './task-runtime-timing.ts';

export interface ActivityCounts {
  running: number;
  waiting: number;
  queued: number;
  succeeded: number;
  failed: number;
  canceled: number;
}
export interface OrganizationActivityOverview {
  organizations: (ManagedOrganization & { counts: ActivityCounts })[];
  nextCursor: string | null;
}
export interface OrganizationActivityPeople {
  organization: ManagedOrganization;
  people: (OrganizationPerson & {
    counts: ActivityCounts;
    computerCount: number;
    applicationCount: number;
    lastDeviceSeenAt: string | null;
  })[];
  nextCursor: string | null;
}
export interface OrganizationActivityRuns {
  organizationId: string;
  userId: string;
  employees: { id: string; name: string }[];
  runs: {
    id: string;
    workspaceId: string;
    sessionId: string;
    title: string;
    employeeId: string;
    employeeName: string;
    status: keyof ActivityCounts;
    createdAt: string;
    completedAt: string | null;
    stage: string;
    timing: TaskRuntimeTiming | null;
  }[];
  nextCursor: string | null;
}
