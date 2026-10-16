import { localExecutionRequestTimeoutMs } from './local-execution-timing.js';
import {
  SandboxNetworkLeaseSchema,
  runtimeContractEqual,
  type RuntimeLocalCommand,
  type RuntimeLocalPythonPayload,
  type SandboxNetworkErrorCode,
  type SandboxNetworkLease,
} from '@allrice/contracts';
import {
  openSandboxNetwork,
  SandboxNetworkError,
  type SandboxNetworkSession,
} from '@allrice/project-runtime';
import type { LocalDockerApi } from './local-docker-api.js';

type Payload = RuntimeLocalCommand | RuntimeLocalPythonPayload;
export function requireLocalSandboxNetwork(
  payload: Payload,
  lease: SandboxNetworkLease | undefined,
  attemptId: string,
) {
  if (payload.arguments.network === 'none') {
    if (lease) throw new SandboxNetworkError('SANDBOX_NETWORK_DENIED');
    return;
  }
  const current = SandboxNetworkLeaseSchema.safeParse(lease);
  if (
    !current.success ||
    !payload.executionBudget ||
    !payload.networkGrant ||
    current.data.target.kind !== 'bridge' ||
    current.data.attemptId !== attemptId ||
    current.data.grantId !== payload.networkGrant.id ||
    current.data.grantVersion !== payload.networkGrant.version ||
    !runtimeContractEqual(current.data.network, payload.arguments.network) ||
    Date.parse(current.data.expiresAt) <= Date.now()
  )
    throw new SandboxNetworkError('SANDBOX_NETWORK_DENIED');
}

/** Private per-attempt transport. Neither a TCP listener on the host nor a
 * Docker network is opened. Trusted PID 1 gates every tenant process. */
export class LocalSandboxNetwork {
  private session?: SandboxNetworkSession;
  private error?: SandboxNetworkErrorCode;
  private closing = false;
  private closeTask?: Promise<void>;
  constructor(
    private readonly options: {
      api: LocalDockerApi;
      containerId: string;
      attemptId: string;
      attemptLabel?: string;
      lease: SandboxNetworkLease;
      signal: AbortSignal;
      maintainLease: () => Promise<boolean>;
      stop: (reason: 'lease_lost' | 'supervisor_failed') => Promise<unknown>;
      relayRuntime: 'node' | 'python';
      projectRuntime?: true;
      allowExecution: () => Promise<void>;
    },
  ) {}
  private async inspect() {
    const o = this.options;
    const c = await o.api.json<{
      Id: string;
      Config: { Labels: Record<string, string> };
      HostConfig: { NetworkMode: string; Privileged: boolean };
      State: { Running: boolean };
    }>('GET', `/containers/${o.containerId}/json`, undefined, 2000);
    if (
      c.Id !== o.containerId ||
      c.Config.Labels[o.attemptLabel ?? 'xyz.bplabs.allrice.attempt'] !==
        o.attemptId ||
      c.HostConfig.NetworkMode !== 'none' ||
      c.HostConfig.Privileged
    )
      throw new SandboxNetworkError('SANDBOX_NETWORK_DENIED');
    return c;
  }
  async start() {
    const o = this.options;
    this.session = await openSandboxNetwork(o.api, {
      containerId: o.containerId,
      lease: o.lease,
      authorityTimeoutMs: localExecutionRequestTimeoutMs,
      signal: o.signal,
      relayRuntime: o.relayRuntime,
      relayUid: 65533,
      ...(o.projectRuntime ? { projectRuntime: true as const } : {}),
      assertContainer: async () => {
        if (!(await this.inspect()).State.Running)
          throw new SandboxNetworkError('SANDBOX_NETWORK_REVOKED');
      },
      assertCurrent: async () => {
        o.signal.throwIfAborted();
        if (!(await o.maintainLease()))
          throw new SandboxNetworkError('SANDBOX_NETWORK_REVOKED');
      },
      onError: (code) => {
        this.error ??= code;
      },
      onClosed: (code) => {
        this.closeTask = (async () => {
          if (this.closing) return;
          if (code === 'SANDBOX_NETWORK_UNAVAILABLE') {
            try {
              await o.api.json(
                'POST',
                `/containers/${o.containerId}/wait?condition=not-running`,
                undefined,
                1000,
              );
              if (!(await this.inspect()).State.Running) return;
            } catch {
              /* Unconfirmed helper exit still fences the attempt. */
            }
          }
          if (this.closing) return;
          // A later grant/transport failure cannot change a terminal process.
          // Running/unknown processes still fail closed below.
          const terminal = await this.inspect().then(
            (container) => !container.State.Running,
            () => false,
          );
          if (terminal) return;
          this.error ??= code;
          await o.stop(
            code === 'SANDBOX_NETWORK_REVOKED'
              ? 'lease_lost'
              : 'supervisor_failed',
          );
        })().catch(() => {
          this.error ??= code;
        });
      },
    });
    o.signal.throwIfAborted();
    await o.allowExecution();
  }
  get evidence() {
    return {
      network: this.session?.observation ?? {
        sentBytes: 0,
        receivedBytes: 0,
        openedConnections: 0,
      },
      ...(this.error ? { errorCode: this.error } : {}),
    };
  }
  async finish() {
    this.closing = true;
    this.session?.close();
    await this.closeTask;
  }
}

/** A physically stopped process cannot settle a request already sent to an
 * external service. Recovery without counters must also remain uncertain. */
export function unconfirmedLocalNetworkOutcome(
  payload: Payload,
  result: {
    reason: string;
    exitCode: number | null;
    network?: { sentBytes: number };
    errorCode?: string;
  },
) {
  return (
    payload.arguments.network !== 'none' &&
    (result.reason !== 'exited' ||
      result.exitCode !== 0 ||
      !!result.errorCode) &&
    (!result.network || result.network.sentBytes > 0)
  );
}
