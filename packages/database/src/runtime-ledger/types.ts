import type {
  RuntimeBridgePayload,
  RuntimeActionBinding,
  RuntimeAttemptRef,
  RuntimeOperationSignal,
  RuntimeOperationSnapshot,
  RuntimeScope,
  RuntimeTaskRef,
  RuntimeUsageObservation,
  BrowserCommand,
} from '@allrice/contracts';
import type postgres from 'postgres';

export type RuntimeLedgerTransaction = postgres.TransactionSql;

/** Trusted server adapter, never a browser-supplied authorization boolean.
 * The ledger rechecks create/heartbeat after its last write: those phases must
 * be repeatable and never consume approvals. Only dispatch consumes once.
 */
export type RuntimeLedgerAdmission = (input: {
  transaction: RuntimeLedgerTransaction;
  binding: RuntimeActionBinding;
  phase: 'create' | 'dispatch' | 'heartbeat';
  now: Date;
}) => Promise<void | { status: 'waiting_user' }>;

export interface RuntimeBudgetLimit {
  metric: RuntimeUsageObservation['metric'];
  unit: RuntimeUsageObservation['unit'];
  currency: string | null;
  capacity: number;
  /** A single authenticated, non-overlapping authoritative meter per metric. */
  source: RuntimeUsageObservation['source'];
}

export interface RuntimeBudgetReservation {
  metric: RuntimeUsageObservation['metric'];
  accountingId: string;
  amount: number;
}

export interface CreateRuntimeOperationInput {
  snapshot: RuntimeOperationSnapshot;
  reservations: RuntimeBudgetReservation[];
  /** Governed ledger payload, separate from the legacy Bridge capability set. */
  bridgePayload?: RuntimeBridgePayload;
  /** Dedicated browser adapter; never the folder-bound Bridge operation port. */
  localBrowserPayload?: BrowserCommand;
}

export interface RuntimeLedgerReceipt {
  scope: RuntimeScope;
  operationId: string;
  leaseToken: string;
  receiptId: string;
  attempt: RuntimeAttemptRef;
  signal: RuntimeOperationSignal;
  deviceSequence?: number;
  /** Caller authenticates/redacts evidence first; bounded opaque result, not instructions. */
  evidence?: unknown;
}

export interface RuntimeLedgerLease {
  snapshot: RuntimeOperationSnapshot;
  leaseToken: string;
  leaseExpiresAt: string;
  createdAt: string;
  bridgePayload: RuntimeBridgePayload | null;
}

export interface RegisterRuntimeRootInput {
  /** Caller has authenticated the owner and selected immutable root limits. */
  task: RuntimeTaskRef;
  deadlineAt: string;
  budgets: RuntimeBudgetLimit[];
}

export class RuntimeLedgerError extends Error {
  constructor(
    public readonly code:
      | 'scope_mismatch'
      | 'unavailable'
      | 'idempotency_conflict'
      | 'budget_exhausted'
      | 'root_canceled'
      | 'deadline_exceeded'
      | 'lease_lost'
      | 'receipt_conflict'
      | 'invalid_state'
      | 'invalid_usage',
  ) {
    super(code);
  }
}
