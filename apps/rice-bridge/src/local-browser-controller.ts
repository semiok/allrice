import { createHash, randomUUID } from 'node:crypto';
import {
  localBrowserControllerLeaseMs,
  canonicalRuntimeBridgeJson,
  localBrowserProfileBinding,
  runtimeContractEqual,
  type BrowserObservation,
  type LocalBrowserControllerLease,
  type LocalBrowserOperation,
  type LocalBrowserReceipt,
  type LocalBrowserRevocation,
  type LocalBrowserWorkspace,
} from '@allrice/contracts';
import {
  LocalBrowserTransportError,
  type LocalBrowserAuthority,
} from './local-browser-client.js';
import {
  startLocalBrowserDriver,
  type LocalBrowserDriver,
} from './local-browser-driver.js';
import type { LocalBrowserOutbox } from './local-browser-outbox.js';
import type { LocalBrowserProfiles } from './local-browser-profiles.js';

type Active = {
  workspace: LocalBrowserWorkspace;
  lease: LocalBrowserControllerLease;
  deadline: number;
  driver?: LocalBrowserDriver;
  starting?: Promise<LocalBrowserDriver>;
  closing?: Promise<void>;
  operation: LocalBrowserOperation | null;
  operationLeaseToken: string | null;
  observing: boolean;
  pendingRequests: number;
  networkEffect: boolean;
  uncertain: boolean;
};
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const lost = () => Error('LOCAL_BROWSER_LEASE_LOST');
const digest = (value: unknown) =>
  `sha256:${createHash('sha256').update(canonicalRuntimeBridgeJson(value)).digest('hex')}`;

/** One owned device controller; server P21 authority remains the sole arbiter.
 * No folder grant, no replay, and no renderer access to the device auth token. */
export class LocalBrowserController {
  readonly controllerId = randomUUID();
  private active: Active | null = null;
  private stopping = false;
  private heartbeatBusy = false;
  constructor(
    private readonly input: {
      deviceId: string;
      authority: LocalBrowserAuthority;
      profiles: LocalBrowserProfiles;
      outbox: LocalBrowserOutbox;
      enabled: () => Promise<boolean>;
      paired: () => Promise<boolean>;
      startDriver?: typeof startLocalBrowserDriver;
      onError?: (
        code: 'LOCAL_BROWSER_UNAVAILABLE' | 'LOCAL_BROWSER_CLEANUP_PENDING',
      ) => void;
    },
  ) {}
  private owned(active: Active) {
    return {
      workspaceId: active.workspace.id,
      controllerLeaseToken: active.lease.token,
    };
  }
  private validLease(
    lease: LocalBrowserControllerLease,
    workspace: LocalBrowserWorkspace,
    sentAt: number,
  ) {
    const expiry = Date.parse(lease.expiresAt);
    if (
      lease.workspaceId !== workspace.id ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry > Date.now() + localBrowserControllerLeaseMs + 500
    )
      throw lost();
    return Math.min(
      expiry,
      sentAt + localBrowserControllerLeaseMs,
      Date.parse(workspace.expiresAt),
    );
  }
  private async assertAlive(active: Active) {
    if (
      this.stopping ||
      this.active !== active ||
      active.closing ||
      Date.now() >= active.deadline ||
      active.workspace.revoked ||
      !(await this.input.paired()) ||
      !(await this.input.enabled())
    )
      throw lost();
    const workspace = active.workspace;
    if (
      workspace.desiredControl === 'closed' ||
      ['closed', 'unknown', 'close_pending'].includes(workspace.state)
    )
      throw lost();
  }
  private async assertCurrent(active: Active) {
    await this.assertAlive(active);
    const workspace = active.workspace;
    if (active.operation && !active.observing) {
      const command = active.operation.command;
      if (
        command.fence !== workspace.fence ||
        workspace.acknowledgedFence !== workspace.fence ||
        command.actor !== workspace.state ||
        command.actor !== workspace.desiredControl
      )
        throw Error('LOCAL_BROWSER_CONTROL_CHANGED');
    } else if (!active.observing) throw Error('LOCAL_BROWSER_CONTROL_CHANGED');
  }
  private async flush() {
    for (const receipt of await this.input.outbox.pending()) {
      await this.input.authority.acknowledge({ kind: 'receipt', ...receipt });
      await this.input.outbox.acknowledge(receipt);
    }
  }
  private async stopActive(active: Active, revoked = false) {
    if (active.closing) return active.closing;
    active.closing = (async () => {
      let confirmed = true;
      try {
        const driver =
          active.driver ??
          (await active.starting?.catch((error: unknown) => {
            // Only this driver's explicit clean-failure code proves startup
            // left no live process. Unknown cleanup must retain the workspace.
            if (
              error instanceof Error &&
              error.message === 'LOCAL_BROWSER_UNAVAILABLE'
            )
              return undefined;
            throw error;
          }));
        await driver?.close(revoked ? 'revoked' : 'lost');
      } catch {
        confirmed = false;
      }
      if (revoked) {
        try {
          await this.input.profiles.revoke(
            localBrowserProfileBinding(active.workspace),
          );
        } catch {
          confirmed = false;
        }
      }
      try {
        await this.input.authority.acknowledge({
          kind: 'stopped',
          ...this.owned(active),
          confirmed,
          errorCode: confirmed ? null : 'LOCAL_BROWSER_CLEANUP_PENDING',
        });
      } catch {
        /* No local execution is resumed when a stop ACK is lost. */
      }
      if (this.active === active) this.active = null;
      if (!confirmed) {
        this.stopping = true;
        this.input.onError?.('LOCAL_BROWSER_CLEANUP_PENDING');
        throw Error('LOCAL_BROWSER_CLEANUP_PENDING');
      }
    })();
    return active.closing;
  }
  private async revoke(revocation: LocalBrowserRevocation) {
    if (revocation.deviceId !== this.input.deviceId) throw lost();
    let confirmed = true;
    const active = this.active;
    try {
      if (active?.workspace.grantId === revocation.grantId)
        await this.stopActive(active, true);
      await this.input.profiles.revoke(revocation);
    } catch {
      confirmed = false;
    }
    await this.input.authority.acknowledge({
      kind: 'revoke_ack',
      grantId: revocation.grantId,
      grantRevision: revocation.grantRevision,
      logicalProfileId: revocation.logicalProfileId,
      confirmed,
      errorCode: confirmed ? null : 'LOCAL_BROWSER_CLEANUP_PENDING',
    });
    if (!confirmed) throw Error('LOCAL_BROWSER_CLEANUP_PENDING');
  }
  private async retirePairing() {
    this.stopping = true;
    try {
      if (this.active) await this.stopActive(this.active, true);
      await this.input.profiles.revokeDevice(this.input.deviceId);
    } catch {
      this.input.onError?.('LOCAL_BROWSER_CLEANUP_PENDING');
      throw Error('LOCAL_BROWSER_CLEANUP_PENDING');
    }
  }
  async heartbeat() {
    if (this.heartbeatBusy) return;
    this.heartbeatBusy = true;
    const active = this.active;
    try {
      if (!active || active.closing) return;
      const paired = await this.input.paired();
      if (
        !paired ||
        !(await this.input.enabled()) ||
        Date.now() >= active.deadline
      ) {
        if (!paired) await this.retirePairing();
        else await this.stopActive(active);
        return;
      }
      const sentAt = Date.now();
      const response = await this.input.authority.heartbeat({
        kind: 'heartbeat',
        ...this.owned(active),
      });
      if (this.active !== active || active.closing) return;
      if (
        response.lease.token !== active.lease.token ||
        !runtimeContractEqual(
          localBrowserProfileBinding(response.workspace),
          localBrowserProfileBinding(active.workspace),
        ) ||
        response.workspace.id !== active.workspace.id ||
        response.workspace.runId !== active.workspace.runId ||
        response.workspace.profileId !== active.workspace.profileId ||
        !runtimeContractEqual(
          response.workspace.profile,
          active.workspace.profile,
        ) ||
        response.workspace.fence < active.workspace.fence
      )
        throw lost();
      active.deadline = this.validLease(
        response.lease,
        response.workspace,
        sentAt,
      );
      active.lease = response.lease;
      active.workspace = response.workspace;
      if (
        response.workspace.revoked ||
        response.workspace.desiredControl === 'closed'
      )
        await this.stopActive(active, response.workspace.revoked);
    } catch (error) {
      if (error instanceof LocalBrowserTransportError && error.status === 401)
        await this.retirePairing().catch(() => undefined);
      else if (active)
        await this.stopActive(
          active,
          error instanceof LocalBrowserTransportError && error.status === 401,
        ).catch(() => undefined);
    } finally {
      this.heartbeatBusy = false;
    }
  }
  private async capture(active: Active): Promise<BrowserObservation> {
    if (!active.driver) throw lost();
    active.observing = true;
    try {
      const fence = active.workspace.fence;
      await this.assertCurrent(active);
      const capture = await active.driver.observe(fence);
      await this.assertCurrent(active);
      if (
        active.workspace.fence !== fence ||
        capture.observation.profileId !== active.workspace.profileId ||
        capture.observation.fence !== fence
      )
        throw lost();
      const objectId = await this.input.authority.capture(
        {
          kind: 'screenshot',
          ...this.owned(active),
          fence,
          observationId: capture.observation.id,
        },
        capture.screenshot,
      );
      capture.screenshot.fill(0);
      const observation = {
        ...capture.observation,
        screenshotObjectId: objectId,
      };
      await this.input.authority.acknowledge({
        kind: 'observation',
        ...this.owned(active),
        observation,
      });
      return observation;
    } finally {
      active.observing = false;
    }
  }
  private async settle(active: Active) {
    while (active.pendingRequests > 0) {
      await this.assertCurrent(active);
      await sleep(20);
    }
    if (active.uncertain) throw Error('LOCAL_BROWSER_IO_UNKNOWN');
  }
  private async execute(active: Active, operation: LocalBrowserOperation) {
    const command = operation.command;
    const binding = operation.snapshot.binding;
    if (
      command.workspaceId !== active.workspace.id ||
      command.profileId !== active.workspace.profileId ||
      command.fence !== active.workspace.fence ||
      command.action.type === 'request' ||
      binding.execution.targetKind !== 'rice_bridge' ||
      binding.execution.deviceId !== this.input.deviceId ||
      binding.execution.grantId !== active.workspace.grantId ||
      binding.execution.grantVersion !== active.workspace.grantRevision ||
      binding.execution.workCopy.id !== active.workspace.profileId ||
      binding.execution.workCopy.kind !== 'local_copy' ||
      binding.execution.scopeDigest !== digest(active.workspace.profile) ||
      binding.inputDigest !== digest(command) ||
      binding.action !==
        (command.action.type === 'observe'
          ? 'local.browser.observe'
          : 'local.browser.act') ||
      binding.requestedBy.type !== 'user' ||
      binding.requestedBy.id !== active.workspace.ownerId ||
      binding.task.runId !== active.workspace.runId ||
      binding.task.rootRunId !== active.workspace.rootRunId ||
      binding.task.chatSessionId !== active.workspace.sessionId ||
      !runtimeContractEqual(binding.task.scope, active.workspace.scope)
    )
      throw lost();
    active.operation = operation;
    active.networkEffect = false;
    active.uncertain = false;
    active.operationLeaseToken = null;
    let input: Buffer | undefined;
    try {
      await this.assertCurrent(active);
      const started = await this.input.authority.start({
        kind: 'start',
        ...this.owned(active),
        operationId: binding.attempt.operationId,
      });
      if (!started.mayExecute) return;
      if (
        !started.operationLeaseToken ||
        !runtimeContractEqual(started.snapshot.binding, binding)
      )
        throw lost();
      active.operationLeaseToken = started.operationLeaseToken;
      const receipt: LocalBrowserReceipt = {
        ...this.owned(active),
        operationId: binding.attempt.operationId,
        operationLeaseToken: started.operationLeaseToken,
        receiptId: randomUUID(),
        status: 'unknown',
        networkEffect: false,
        observationId: null,
        downloadObjectId: null,
        errorCode: 'LOCAL_BROWSER_IO_UNKNOWN',
      };
      await this.input.outbox.prepare(receipt);
      try {
        if (
          command.action.type === 'upload' ||
          command.action.type === 'sensitive_fill'
        ) {
          input = await this.input.authority.takeInput(
            {
              kind: 'take_input',
              ...this.owned(active),
              operationId: binding.attempt.operationId,
              operationLeaseToken: started.operationLeaseToken,
              inputKind:
                command.action.type === 'upload' ? 'upload' : 'private',
            },
            command.action.type === 'upload'
              ? active.workspace.profile.maximumFileBytes
              : 8192,
          );
        }
        await this.assertCurrent(active);
        const result = await active.driver!.perform(
          command.action,
          operation.observation,
          input,
        );
        await this.settle(active);
        await this.assertCurrent(active);
        if (result.download) {
          try {
            receipt.downloadObjectId = await this.input.authority.capture(
              {
                kind: 'download',
                ...this.owned(active),
                operationId: binding.attempt.operationId,
                operationLeaseToken: started.operationLeaseToken,
                fileName: result.download.name,
                mediaType: result.download.mediaType,
              },
              result.download.bytes,
            );
          } finally {
            result.download.bytes.fill(0);
          }
        }
        await active.driver!.checkpoint();
        receipt.observationId = (await this.capture(active)).id;
        receipt.status = 'succeeded';
        receipt.errorCode = null;
      } catch {
        /* Once started, never infer that a failed renderer had no effect. */
      }
      receipt.networkEffect = active.networkEffect;
      await this.input.outbox.complete(receipt);
      await this.flush();
      if (receipt.status === 'unknown') await this.stopActive(active);
    } finally {
      input?.fill(0);
      active.operation = null;
      active.operationLeaseToken = null;
    }
  }
  private async begin(
    workspace: LocalBrowserWorkspace,
    lease: LocalBrowserControllerLease,
    sentAt: number,
  ) {
    if (workspace.deviceId !== this.input.deviceId || workspace.revoked)
      throw lost();
    const active: Active = {
      workspace,
      lease,
      deadline: this.validLease(lease, workspace, sentAt),
      observing: true,
      operation: null,
      operationLeaseToken: null,
      pendingRequests: 0,
      networkEffect: false,
      uncertain: false,
    };
    this.active = active;
    active.starting = (this.input.startDriver ?? startLocalBrowserDriver)({
      binding: localBrowserProfileBinding(workspace),
      profiles: this.input.profiles,
      assertAlive: () => this.assertAlive(active),
      leaseExpiresAt: () => active.deadline,
      options: {
        profileId: workspace.profileId,
        profile: workspace.profile,
        assertCurrent: () => this.assertCurrent(active),
        requestStarted: () => {
          active.pendingRequests++;
          let released = false;
          return () => {
            if (!released) {
              released = true;
              active.pendingRequests--;
            }
          };
        },
        requestSent: () => {
          active.networkEffect = true;
        },
        requestApproval: async (effect) => {
          const operation = active.operation;
          const token = active.operationLeaseToken;
          if (!operation || !token || active.observing) throw lost();
          const operationId = operation.snapshot.binding.attempt.operationId;
          await this.assertCurrent(active);
          let approval = await this.input.authority.requestPermission({
            kind: 'request_approval',
            ...this.owned(active),
            requestId: randomUUID(),
            operationId,
            operationLeaseToken: token,
            effect,
          });
          while (approval.status === 'pending') {
            await sleep(100);
            await this.assertCurrent(active);
            approval = await this.input.authority.requestPermission({
              kind: 'request_status',
              ...this.owned(active),
              operationId,
              approvalOperationId: approval.operationId,
            });
          }
          if (approval.status !== 'ready' || !approval.permissionToken)
            throw Error('LOCAL_BROWSER_POLICY_DENIED');
          const permissionToken = approval.permissionToken;
          active.pendingRequests++;
          let completed = false;
          return {
            complete: async (confirmed) => {
              if (completed) return;
              completed = true;
              if (!confirmed) active.uncertain = true;
              try {
                await this.input.authority.acknowledge({
                  kind: 'request_complete',
                  ...this.owned(active),
                  approvalOperationId: approval.operationId,
                  permissionToken,
                  confirmed,
                });
              } catch {
                await this.stopActive(active).catch(() => undefined);
              } finally {
                active.pendingRequests--;
              }
            },
          };
        },
      },
    });
    try {
      active.driver = await active.starting;
      if (active.closing) {
        await active.driver.close('lost');
        return;
      }
      active.observing = false;
    } catch {
      await this.stopActive(active).catch(() => undefined);
      throw lost();
    }
  }
  private async pollCurrent() {
    await this.flush();
    if (this.stopping) return false;
    if (!this.active) {
      const enabled =
        (await this.input.enabled()) && (await this.input.paired());
      const sentAt = Date.now();
      const claim = await this.input.authority.claim(
        this.controllerId,
        enabled,
      );
      for (const revocation of claim.revocations) await this.revoke(revocation);
      if (claim.workspace && claim.lease) {
        if (!enabled) throw lost();
        await this.begin(claim.workspace, claim.lease, sentAt);
      }
    }
    const active = this.active;
    if (!active || active.closing || !active.driver) return false;
    if (
      active.workspace.fence !== active.workspace.acknowledgedFence ||
      active.workspace.state === 'starting'
    ) {
      const observation = await this.capture(active);
      const state = active.workspace.desiredControl;
      await this.input.authority.acknowledge({
        kind: 'control_ack',
        ...this.owned(active),
        fence: active.workspace.fence,
        state,
        observationId: observation.id,
      });
      await this.heartbeat();
      return true;
    }
    if (!['agent', 'human'].includes(active.workspace.state)) return false;
    const operation = await this.input.authority.next({
      kind: 'next',
      ...this.owned(active),
    });
    if (!operation) return false;
    await this.execute(active, operation);
    return true;
  }
  async pollOnce() {
    if (this.stopping) return false;
    if (!(await this.input.paired())) {
      await this.retirePairing();
      return false;
    }
    try {
      return await this.pollCurrent();
    } catch (error) {
      if (error instanceof LocalBrowserTransportError && error.status === 401)
        await this.retirePairing();
      throw error;
    }
  }
  async run(signal: AbortSignal) {
    const abort = () => {
      void this.stop().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    const watchdog = setInterval(() => {
      const active = this.active;
      if (active && !active.closing && Date.now() >= active.deadline)
        void this.stopActive(active).catch(() => undefined);
    }, 100);
    const heartbeat = setInterval(() => {
      void this.heartbeat();
    }, 750);
    let backoff = 150;
    try {
      while (!signal.aborted && !this.stopping) {
        try {
          await this.pollOnce();
          backoff = 150;
        } catch {
          if (this.active) this.input.onError?.('LOCAL_BROWSER_UNAVAILABLE');
          backoff = Math.min(5000, backoff * 2);
        }
        if (!signal.aborted) await sleep(backoff);
      }
    } finally {
      clearInterval(watchdog);
      clearInterval(heartbeat);
      signal.removeEventListener('abort', abort);
      await this.stop();
    }
  }
  async stop() {
    this.stopping = true;
    if (this.active) await this.stopActive(this.active);
  }
}
