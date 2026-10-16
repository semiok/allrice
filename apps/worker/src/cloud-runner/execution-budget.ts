import { randomUUID } from 'node:crypto';
import {
  runtimeContractEqual,
  SandboxExecutionBudgetStateSchema,
  SandboxExecutionProgressSchema,
  type SandboxExecutionBudgetSpec,
  type SandboxExecutionBudgetState,
  type SandboxExecutionProgress,
  type SandboxExecutionRenewal,
} from '@allrice/contracts';

/** One authority clock across preparation, installation and execution. The
 * caller supplies measured cumulative progress and bounds authority I/O. */
export class CloudExecutionBudget {
  private value: SandboxExecutionBudgetState;
  private pending?: SandboxExecutionRenewal;

  constructor(
    initial: unknown,
    spec: SandboxExecutionBudgetSpec,
    private readonly exchange: (
      request: SandboxExecutionRenewal,
    ) => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {
    const parsed = SandboxExecutionBudgetStateSchema.safeParse(initial);
    if (!parsed.success) throw Error('SANDBOX_EXECUTION_POLICY_CHANGED');
    this.value = parsed.data;
    if (
      !runtimeContractEqual(this.value.spec, spec) ||
      this.value.deadlineAt <= now()
    )
      throw Error('SANDBOX_EXECUTION_POLICY_CHANGED');
  }

  get state() {
    return this.value;
  }

  get observation() {
    const state = this.value;
    return {
      startedAt: state.startedAt,
      hardDeadlineAt: state.hardDeadlineAt,
      deadlineAt: state.deadlineAt,
      initialBudgetMs: state.spec.initialBudgetMs,
      maxExecutionMs: state.spec.policy.maxExecutionMs,
      renewalCount: state.sequence,
    };
  }

  async renew(progress: () => Promise<SandboxExecutionProgress>) {
    const state = this.value;
    if (this.now() >= state.deadlineAt)
      throw Error('SANDBOX_EXECUTION_DEADLINE');
    if (
      state.deadlineAt - this.now() > 15000 ||
      state.deadlineAt === state.hardDeadlineAt
    )
      return;
    // Preserve the exact request across an uncertain acknowledgement. Neither
    // a phase change nor a transport retry may allocate another extension.
    this.pending ??= {
      requestId: randomUUID(),
      sequence: state.sequence + 1,
      progress: SandboxExecutionProgressSchema.parse(await progress()),
    };
    const request = this.pending;
    const parsed = SandboxExecutionBudgetStateSchema.safeParse(
      await this.exchange(request),
    );
    if (!parsed.success) throw Error('SANDBOX_EXECUTION_POLICY_CHANGED');
    const renewed = parsed.data;
    if (
      !runtimeContractEqual(renewed.spec, state.spec) ||
      renewed.startedAt !== state.startedAt ||
      renewed.hardDeadlineAt !== state.hardDeadlineAt ||
      renewed.sequence !== request.sequence ||
      !runtimeContractEqual(renewed.renewals.slice(0, -1), state.renewals) ||
      !runtimeContractEqual(renewed.progress, request.progress) ||
      !runtimeContractEqual(renewed.renewals.at(-1), {
        ...request,
        grantedAt: renewed.renewals.at(-1)?.grantedAt,
        deadlineAt: renewed.deadlineAt,
      }) ||
      renewed.deadlineAt <= state.deadlineAt ||
      renewed.deadlineAt > state.deadlineAt + 60000 ||
      renewed.deadlineAt <= this.now()
    )
      throw Error('SANDBOX_EXECUTION_POLICY_CHANGED');
    this.value = renewed;
    this.pending = undefined;
  }
}
