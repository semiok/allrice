import {
  runtimeContractEqual,
  SandboxExecutionProgressSchema,
  type RuntimeLocalCommand,
  type RuntimeLocalPythonPayload,
} from '@allrice/contracts';
import type { SandboxExecutionBudgetController } from '@allrice/project-runtime';
import { LocalServiceControl } from './local-service-control.js';
import type { LocalDockerApi } from './local-docker-api.js';
import { LocalCommandError } from './local-command-inputs.js';

export function requireLocalExecutionBudget(
  command: RuntimeLocalCommand | RuntimeLocalPythonPayload,
  budget?: SandboxExecutionBudgetController,
  maintainLease?: () => Promise<boolean>,
) {
  if (
    Boolean(command.executionBudget) !== Boolean(budget) ||
    (budget &&
      (!maintainLease ||
        !runtimeContractEqual(command.executionBudget, budget.state.spec) ||
        budget.state.deadlineAt <= Date.now()))
  )
    throw new LocalCommandError('SANDBOX_EXECUTION_POLICY_CHANGED');
}

/** A private PID 1 lease, separate from both operation leases and work budgets.
 * Every control write follows current admission. Daemon metrics are trusted;
 * stdout, model text and an alive heartbeat are never proof of progress. */
export class LocalExecutionControl {
  private socket?: LocalServiceControl;
  private timer?: ReturnType<typeof setInterval>;
  private task?: Promise<void>;
  private closed = false;
  private sequence = 0;
  private networkReady = false;
  constructor(
    private readonly input: {
      api: LocalDockerApi;
      containerId: string;
      attemptId: string;
      attemptLabel?: string;
      budget: SandboxExecutionBudgetController;
      maintainLease: () => Promise<boolean>;
      stop: (reason: 'timeout' | 'lease_lost') => Promise<void>;
    },
  ) {}

  private async running() {
    const { api, containerId, attemptId } = this.input;
    const c = await api.json<{
      Id: string;
      Config: { Labels: Record<string, string> };
      State: { Running: boolean; Status: string };
    }>('GET', `/containers/${containerId}/json`, undefined, 500);
    if (
      c.Id !== containerId ||
      c.Config.Labels[
        this.input.attemptLabel ?? 'xyz.bplabs.allrice.attempt'
      ] !== attemptId ||
      (!c.State.Running && c.State.Status !== 'exited')
    )
      throw new LocalCommandError('SANDBOX_EXECUTION_PROCESS_CHANGED');
    return c.State.Running;
  }

  private async progress() {
    if (!(await this.running())) return null;
    const { api, containerId } = this.input;
    const stats = await api.json<{
      cpu_stats?: { cpu_usage?: { total_usage?: number } };
      blkio_stats?: {
        io_service_bytes_recursive?: { op: string; value: number }[];
      };
    }>(
      'GET',
      `/containers/${containerId}/stats?stream=false&one-shot=true`,
      undefined,
      1500,
    );
    // Exits can race metrics collection. Never substitute zero live metrics.
    if (!(await this.running())) return null;
    const io = stats.blkio_stats?.io_service_bytes_recursive ?? [];
    const bytes = (op: string) =>
      io
        .filter((r) => r.op.toLowerCase() === op)
        .reduce((n, r) => n + r.value, 0);
    return SandboxExecutionProgressSchema.parse({
      cpuNanos: stats.cpu_stats?.cpu_usage?.total_usage,
      readBytes: bytes('read'),
      writtenBytes: bytes('write'),
    });
  }

  private async tick() {
    const { budget, maintainLease, attemptId } = this.input;
    try {
      if (this.closed) return;
      if (!(await this.running())) return this.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const [allowed] = await Promise.race([
        Promise.all([maintainLease(), budget.renew(() => this.progress())]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new LocalCommandError('EXECUTION_CONTROL_TIMEOUT')),
            3000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (this.closed) return;
      // Do not convert a terminal success to an authority/control failure.
      if (!(await this.running())) return this.close();
      if (!allowed) throw new LocalCommandError('EXECUTION_REVOKED');
      const now = Date.now();
      if (now >= budget.state.deadlineAt)
        throw new LocalCommandError('SANDBOX_EXECUTION_DEADLINE');
      await this.socket!.send({
        type: 'execution_renew',
        ...(this.networkReady ? { networkReady: true } : {}),
        attemptId,
        sequence: ++this.sequence,
        deadlineAt: budget.state.deadlineAt,
        leaseDeadlineAt: Math.min(now + 5000, budget.state.deadlineAt),
      });
    } catch (error) {
      if (this.closed) return;
      const running = await this.running().catch(() => true);
      this.close();
      if (running)
        await this.input.stop(
          error instanceof Error &&
            error.message === 'SANDBOX_EXECUTION_DEADLINE'
            ? 'timeout'
            : 'lease_lost',
        );
    }
  }

  async start() {
    try {
      this.socket = await LocalServiceControl.connect(
        this.input.api.socketPath,
        this.input.containerId,
      );
    } catch (error) {
      if (!(await this.running())) return this.close();
      throw error;
    }
    if (this.closed) return this.socket.close();
    await this.tick();
    if (this.closed) return;
    this.timer = setInterval(() => {
      if (this.task || this.closed) return;
      this.task = this.tick()
        .catch(() => this.close())
        .finally(() => {
          this.task = undefined;
        });
    }, 1000);
  }

  /** Release the tenant start gate only after the scoped relay is ready. */
  async allowNetwork() {
    if (this.task) await this.task;
    if (this.closed) throw new LocalCommandError('EXECUTION_REVOKED');
    this.networkReady = true;
    const task = this.tick();
    this.task = task;
    try {
      await task;
      if (this.closed) throw new LocalCommandError('EXECUTION_REVOKED');
    } finally {
      if (this.task === task) this.task = undefined;
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.socket?.close();
  }

  async finish() {
    this.close();
    await this.task;
  }
}
