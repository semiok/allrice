import { z } from 'zod';
import { UuidSchema } from './common.ts';
import type { ManagedOrganization } from './organization-administration.ts';
import type { ActivityCounts } from './organization-activity.ts';

export const OrganizationDashboardFilterSchema = z
  .object({
    range: z.enum(['7d', '30d', 'custom']).default('7d'),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    timeZone: z.string().max(80).default('Asia/Shanghai'),
    userId: UuidSchema.optional(),
    employeeId: UuidSchema.optional(),
    jobTitle: z.string().trim().max(160).optional(),
  })
  .superRefine((value, ctx) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value.timeZone });
    } catch {
      ctx.addIssue({ code: 'custom', path: ['timeZone'], message: '无效时区' });
    }
    if (value.range === 'custom') {
      const from = value.from ? Date.parse(value.from) : NaN;
      const to = value.to ? Date.parse(value.to) : NaN;
      if (!(to > from) || to - from > 366 * 86400000)
        ctx.addIssue({
          code: 'custom',
          path: ['from'],
          message: '请选择有效起止时间，最长 366 天。',
        });
    }
  });
export type OrganizationDashboardFilter = z.infer<
  typeof OrganizationDashboardFilterSchema
>;

export interface OrganizationDashboard {
  organization: ManagedOrganization;
  period: { from: string; to: string; timeZone: string };
  updatedAt: string;
  people: {
    activeEmployees: number;
    inactiveEmployees: number;
    assignedEmployees: number;
    activeParticipants: number;
    historicalParticipants: number;
  };
  work: {
    started: number;
    completed: number;
    failed: number;
    canceled: number;
    current: Pick<ActivityCounts, 'running' | 'waiting' | 'queued'>;
  };
  deliverables: {
    availableSeries: number;
    firstDeliveries: number;
    revisedSeries: number;
  };
  usage: {
    receiptCount: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    incompleteReceipts: number;
    unknownCacheReceipts: number;
    pricedReceipts: number;
    subscriptionReceipts: number;
    unknownCostReceipts: number;
    terminalRuns: number;
    terminalRunsWithReceipts: number;
    // Legacy ledger cents have no frozen currency. Do not call them a bill,
    // convert them to CNY/USD, or add assistant upper bounds a second time.
    recordedCostCents: number | null;
    currency: null;
    costBasis: 'ledger-records-without-billing-currency';
  };
  filters: {
    employees: { id: string; name: string }[];
    jobTitles: string[];
  };
}
