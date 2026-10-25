import { createHash } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import {
  TerminalController,
  type Config as TerminalControllerConfig,
  type TerminalInput,
} from '@deepseek-ai/dsh-api-terminal-controller';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import type { TerminalTarget } from '@allrice/contracts';
import { readConfig, type BridgeConfig } from './config.js';
import { humanTerminalLocaleEnvironment } from './human-terminal-environment.js';

type NativeOwner = Parameters<TerminalController['create']>[0];
type NativeSession = NativeOwner['session'];
type AuthorityObservation = {
  checkedAt: number;
  lastCurrentAt: number;
  result: 'current' | 'revoked' | 'unknown';
  pending?: Promise<void>;
};

/** Keep native process ownership and credential scrubbing; only the human
 * terminal's locale overrides differ from the stock provider. */
class HumanTerminalSubprocessRuntime extends LocalSubprocessRuntime {
  override spawnTerminal(
    spec: Parameters<LocalSubprocessRuntime['spawnTerminal']>[0],
  ) {
    return super.spawnTerminal({
      ...spec,
      env: {
        ...spec.env,
        ...humanTerminalLocaleEnvironment({ ...process.env, ...spec.env }),
      },
    });
  }
}

/** This is the only AllRice-to-DSH execution adapter. The native controller owns
 * PTYs, screens, input ordering, retention, cleanup and process exit facts. A
 * grant chooses the initial directory; this human shell has the OS user's
 * permissions, independently of the Agent execution sandbox. */
export class HumanTerminalHost {
  private readonly ctx = new Context();
  private readonly controller: TerminalController;
  private readonly owners = new Map<string, HumanTerminalOwner>();
  private readonly removals = new Map<HumanTerminalOwner, Promise<void>>();
  private readonly pendingAuthorization = new Set<Promise<void>>();
  private disposed = false;
  private readonly authorization = new Map<string, AuthorityObservation>();

  constructor(
    private readonly options: {
      server: string;
      deviceId: string;
      currentConfig?: () => Promise<BridgeConfig>;
      authorizeTarget: (
        target: TerminalTarget,
      ) => Promise<'current' | 'revoked' | 'unknown'>;
      /** Explicit deployment/test policy; omission retains native defaults. */
      terminal?: Partial<TerminalControllerConfig>;
    },
  ) {
    new HumanTerminalSubprocessRuntime(this.ctx);
    // DSH explicitly separates user terminals from Agent sandbox approval. Its
    // controller requires this provider's presence but never calls its policy.
    this.ctx.provide('sandboxPolicy', {});
    this.ctx.provide('workingDirectory', {
      get: (session: NativeSession) => this.directory(session.id),
      ensure: async (agent: NativeOwner, signal: AbortSignal) => {
        signal.throwIfAborted();
        const owner = this.owners.get(agent.id);
        if (!owner) throw Error('HUMAN_TERMINAL_OWNER_UNAVAILABLE');
        const directory = await this.validate(owner.target);
        signal.throwIfAborted();
        return directory;
      },
    });
    this.controller = new TerminalController(
      this.ctx,
      TerminalController.Config({
        ...TerminalController.Config(),
        ...options.terminal,
      }),
    );
  }

  /** Validate local facts as well as the server-authenticated target. No local
   * path is accepted from the browser, and symlink/root changes fail closed. */
  async validate(target: TerminalTarget, refresh = false): Promise<string> {
    if (this.disposed) throw Error('HUMAN_TERMINAL_HOST_CLOSED');
    const config = await (this.options.currentConfig ?? readConfig)();
    if (
      this.disposed ||
      config.paused ||
      config.server !== this.options.server ||
      config.deviceId !== this.options.deviceId ||
      target.deviceId !== config.deviceId
    )
      throw Error('HUMAN_TERMINAL_DEVICE_UNAVAILABLE');
    const grant = config.grants.find((entry) => entry.id === target.grantId);
    if (
      !grant ||
      grant.revokedAt ||
      grant.rootFingerprint !== target.rootFingerprint
    )
      throw Error('HUMAN_TERMINAL_GRANT_UNAVAILABLE');
    const root = await realpath(grant.rootPath);
    if (
      root !== grant.rootPath ||
      createHash('sha256').update(root).digest('hex') !==
        target.rootFingerprint ||
      !(await stat(root)).isDirectory()
    )
      throw Error('HUMAN_TERMINAL_GRANT_CHANGED');
    await access(root, constants.R_OK | constants.X_OK);
    await this.authorize(target, refresh);
    if (this.disposed) throw Error('HUMAN_TERMINAL_HOST_CLOSED');
    return root;
  }

  async acquire(target: TerminalTarget) {
    const directory = await this.validate(target);
    const key = ownerKey(target);
    let owner = this.owners.get(key);
    if (!owner) {
      // Native terminal quotas are per Session. Keep the host's Session table
      // bounded too; empty, detached Sessions are removed before this check.
      await this.prune();
      if (this.disposed) throw Error('HUMAN_TERMINAL_HOST_CLOSED');
      owner = this.owners.get(key);
    }
    if (!owner) {
      if (this.owners.size >= 64)
        throw Error('HUMAN_TERMINAL_SESSION_LIMIT_REACHED');
      const fiber = this.ctx.plugin(() => {});
      const agent = {
        id: key,
        session: { id: key },
        ctx: fiber.ctx,
      } as unknown as NativeOwner;
      owner = new HumanTerminalOwner(
        target,
        directory,
        agent,
        fiber,
        this.controller,
      );
      this.owners.set(key, owner);
    }
    owner.holds++;
    return owner;
  }

  async release(owner: HumanTerminalOwner, revoke = false) {
    owner.holds = Math.max(0, owner.holds - 1);
    if (revoke) await this.remove(owner);
    else await this.prune();
  }

  /** Called on local grant changes and periodically while paired. A detached
   * terminal must not keep running under a locally revoked device or folder. */
  async revalidate() {
    const results = await Promise.allSettled(
      [...this.owners.values()].map(async (owner) => {
        try {
          await this.validate(owner.target, true);
        } catch (error) {
          if (!isHumanTerminalAuthorityUnknown(error)) await this.remove(owner);
        }
      }),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'HUMAN_TERMINAL_CLEANUP_PENDING',
      );
    await this.prune();
  }

  async dispose() {
    this.disposed = true;
    // Native owner cleanup retries retained failures; do not erase ownership
    // or report a successful shutdown before its awaited process cleanup.
    for (const owner of [...this.owners.values()]) await this.remove(owner);
    await Promise.all(this.pendingAuthorization);
    await this.ctx.fiber.dispose();
  }

  private directory(id: string) {
    const owner = this.owners.get(id);
    if (!owner) throw Error('HUMAN_TERMINAL_OWNER_UNAVAILABLE');
    return owner.directory;
  }

  private remove(owner: HumanTerminalOwner) {
    const current = this.removals.get(owner);
    if (current) return current;
    const removing = Promise.resolve()
      .then(() => owner.dispose())
      .then(() => {
        if (this.owners.get(owner.agent.id) === owner) {
          this.owners.delete(owner.agent.id);
          this.authorization.delete(owner.agent.id);
        }
      })
      .finally(() => {
        if (this.removals.get(owner) === removing) this.removals.delete(owner);
      });
    this.removals.set(owner, removing);
    return removing;
  }

  private async prune() {
    for (const owner of [...this.owners.values()])
      if (
        !owner.holds &&
        !owner.activeCalls &&
        !owner.hasIdentities &&
        !owner.list().length
      )
        await this.remove(owner);
  }

  private async authorize(target: TerminalTarget, refresh: boolean) {
    if (this.disposed) throw Error('HUMAN_TERMINAL_HOST_CLOSED');
    const key = ownerKey(target);
    let observation = this.authorization.get(key);
    if (!observation) {
      if (this.authorization.size >= 128) {
        for (const [id, cached] of this.authorization)
          if (!this.owners.has(id) && !cached.pending)
            this.authorization.delete(id);
        if (this.authorization.size >= 128)
          throw Error('HUMAN_TERMINAL_SESSION_LIMIT_REACHED');
      }
      observation = { checkedAt: 0, lastCurrentAt: 0, result: 'unknown' };
      this.authorization.set(key, observation);
    }
    this.rejectRevoked(observation);
    if (
      !observation.pending &&
      (refresh || Date.now() - observation.checkedAt >= 500)
    ) {
      const current = observation;
      const pending = (async () => {
        const result = await Promise.resolve()
          .then(() => this.options.authorizeTarget(target))
          .catch(() => 'unknown' as const);
        // A retired owner, replaced observation or disposed Bridge cannot be
        // revived by a late HTTP result from its previous authorization check.
        if (this.disposed || this.authorization.get(key) !== current) return;
        current.result = result;
        current.checkedAt = Date.now();
        if (current.result === 'current')
          current.lastCurrentAt = current.checkedAt;
        else if (current.result === 'revoked') {
          const owner = this.owners.get(key);
          // Revocation must stop an idle attachment too, without waiting for
          // another key or the maintenance timer. Reuse retryable native
          // cleanup; failure retains the owner for revalidate()/dispose().
          if (owner) void this.remove(owner).catch(() => {});
        }
      })().finally(() => {
        if (current.pending === pending) delete current.pending;
        this.pendingAuthorization.delete(pending);
      });
      current.pending = pending;
      this.pendingAuthorization.add(pending);
    }
    // Refresh in the background while the existing authorization lease is
    // valid. Waiting for every 500 ms HTTP check adds a network round trip to
    // interactive input and echo. First admission, exact lease expiry and
    // explicit maintenance still await authority; the five-second lease is
    // never extended by an unknown result or an in-flight request.
    if (
      refresh ||
      !observation.lastCurrentAt ||
      Date.now() - observation.lastCurrentAt >= 5_000
    )
      await observation.pending;
    if (this.disposed) throw Error('HUMAN_TERMINAL_HOST_CLOSED');
    this.rejectRevoked(observation);
    if (
      this.authorization.get(key) !== observation ||
      !observation.lastCurrentAt ||
      Date.now() - observation.lastCurrentAt >= 5_000
    )
      throw new HumanTerminalAuthorityUnknown();
  }

  private rejectRevoked(observation: AuthorityObservation) {
    if (observation.result === 'revoked')
      throw Error('HUMAN_TERMINAL_AUTHORIZATION_REVOKED');
  }
}

export function isHumanTerminalAuthorityUnknown(error: unknown) {
  return error instanceof HumanTerminalAuthorityUnknown;
}

class HumanTerminalAuthorityUnknown extends Error {
  constructor() {
    super('HUMAN_TERMINAL_AUTHORIZATION_UNAVAILABLE');
  }
}

function ownerKey(target: TerminalTarget) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        target.organizationId,
        target.workspaceId,
        target.ownerId,
        target.loginSessionId,
        target.sessionId,
        target.deviceId,
        target.grantId,
        target.grantVersion,
        target.rootFingerprint,
      ]),
    )
    .digest('hex');
}

export class HumanTerminalOwner {
  holds = 0;
  activeCalls = 0;
  /** Native closedIds belong to this owner lifetime, including empty screens. */
  hasIdentities = false;
  private closed = false;
  private readonly lifetime = new AbortController();
  private readonly drained = new Set<() => void>();

  constructor(
    readonly target: TerminalTarget,
    readonly directory: string,
    readonly agent: NativeOwner,
    private readonly fiber: Fiber,
    private readonly controller: TerminalController,
  ) {}

  list() {
    // The controller's types import @deepseek-ai/dsh-session without declaring it,
    // so `create` and `list`/`retain` can resolve different hoisted copies (0.1.5
    // and 0.2.1) whose branded ids do not overlap; the value is the same session
    // id, typed by the method that takes it.
    return this.controller.list(
      this.agent.id as unknown as Parameters<TerminalController['list']>[0],
    );
  }

  async call(
    action: 'environment' | 'shells' | 'list' | 'create' | 'rename' | 'close',
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    this.assertOpen();
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    signal.throwIfAborted();
    this.activeCalls++;
    if (action === 'create' || action === 'close') this.hasIdentities = true;
    try {
      switch (action) {
        case 'environment':
          return this.controller.environment(this.agent, signal);
        case 'shells':
          return await this.controller.shells(this.agent, signal);
        case 'list':
          return this.list();
        case 'create':
          return await this.controller.create(
            this.agent,
            args.request as Parameters<TerminalController['create']>[1],
            signal,
          );
        case 'rename':
          return this.controller.rename(
            this.agent,
            args.id as Parameters<TerminalController['rename']>[1],
            args.title as string,
          );
        case 'close':
          return await this.controller.close(
            this.agent,
            args.id as Parameters<TerminalController['close']>[1],
          );
      }
    } finally {
      this.activeCalls--;
      for (const resolve of this.drained) resolve();
      this.drained.clear();
    }
  }

  stream(
    action: 'attach' | 'retain',
    id: string,
    signal: AbortSignal,
    input: AsyncIterable<TerminalInput>,
    inputWindow: { maxBytes: number; frameOverheadBytes: number },
  ) {
    this.assertOpen();
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    signal.throwIfAborted();
    if (action === 'retain')
      return this.controller.retain(
        this.agent.id as unknown as Parameters<TerminalController['retain']>[0],
        id as Parameters<TerminalController['retain']>[1],
        signal,
      );
    const invocation = { uplink: () => input, uplinkWindow: inputWindow };
    return this.fiber.ctx
      .extend({ invocation })
      .terminalController.attach(
        this.agent,
        id as Parameters<TerminalController['attach']>[1],
        signal,
      );
  }

  async dispose() {
    this.closed = true;
    this.lifetime.abort(Error('HUMAN_TERMINAL_OWNER_UNAVAILABLE'));
    while (this.activeCalls)
      await new Promise<void>((resolve) => this.drained.add(resolve));
    // Use the public, retryable close API before disposing the owner context.
    // A failed provider cleanup keeps both the native record and this owner.
    for (const terminal of this.list())
      await this.controller.close(this.agent, terminal.id);
    await this.fiber.dispose();
  }

  private assertOpen() {
    if (this.closed) throw Error('HUMAN_TERMINAL_OWNER_UNAVAILABLE');
  }
}
