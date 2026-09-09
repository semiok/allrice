import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  makeObjectKey,
  RuntimeOperationSnapshotSchema,
  isTerminalRuntimeOperationStatus,
  BrowserCommandSchema,
  type BrowserCommand,
  type BrowserObservation,
  type RuntimeActionBinding,
  type RuntimeOperationSignal,
  type StorageObject,
  type StoragePort,
} from '@allrice/contracts';
import {
  getDatabase,
  browserPrincipal,
  readCurrentBrowserWorkspace,
  acknowledgeBrowserControl,
  recordBrowserObservation,
  recordBrowserStopped,
  createBrowserOperation,
  createBrowserOperationLedger,
  consumeBrowserDirectInput,
  cloudStableId,
  runtimePolicyDigest as digest,
  registerManagedBrowserEvidenceArtifact,
  completeManagedBrowserTask,
  getToolBrokerFile,
  publishBrowserObservationArtifact,
  type BrowserWorkspaceRow,
} from '@allrice/database';
import {
  startBrowserControlDriver,
  type BrowserDriver,
  type BrowserRequestEffect,
} from './driver.js';
type Database = ReturnType<typeof getDatabase>;
type Pending = {
  operation_id: string;
  binding: RuntimeActionBinding;
  payload: BrowserCommand;
  observation: BrowserObservation | null;
  lease_token: string | null;
  started_at: Date | null;
  result: unknown;
};
export type BrowserController = {
  workspaceId: string;
  jobId: string;
  workerId: string;
  closed: Promise<void>;
};
const activeControllers = new Map<string, BrowserController>();
export function ownedBrowserController(
  id: string,
  jobId: string,
  workerId: string,
) {
  const c = activeControllers.get(id);
  if (!c || c.jobId !== jobId || c.workerId !== workerId)
    throw Error('BROWSER_CONTROLLER_UNAVAILABLE');
  return c;
}
const hash = (b: Buffer) =>
  `sha256:${createHash('sha256').update(b).digest('hex')}`;
export async function persistBrowserCapture(
  w: BrowserWorkspaceRow,
  storage: StoragePort,
  bytes: Buffer,
  kind: 'screenshot' | 'download',
  name: string,
  mediaType: string,
) {
  if (!w.task_id) throw Error('BROWSER_CLOUD_TARGET_REQUIRED');
  const taskId = w.task_id;
  const objectId = randomUUID(),
    object: StorageObject = {
      id: objectId,
      organizationId: w.organization_id,
      workspaceId: w.workspace_id,
      ownerId: w.owner_id,
      key: makeObjectKey({
        organizationId: w.organization_id,
        workspaceId: w.workspace_id,
        ownerId: w.owner_id,
        category: 'artifacts',
        objectId,
      }),
      checksum: hash(bytes),
      mediaType,
      sizeBytes: bytes.length,
      retentionUntil: null,
      deletedAt: null,
      immutable: true,
    };
  await storage.put(object, new Blob([Uint8Array.from(bytes)]).stream());
  try {
    await registerManagedBrowserEvidenceArtifact({
      context: w.execution_context,
      lease: { attempt: w.job_attempt, leaseToken: w.job_lease_token },
      taskId,
      kind,
      name,
      object: {
        id: object.id,
        key: object.key,
        checksum: object.checksum,
        mediaType: object.mediaType,
        sizeBytes: object.sizeBytes,
      },
    });
  } catch (error) {
    // An unknown COMMIT acknowledgment is not proof that evidence is orphaned.
    const known =
      await getDatabase()`select id from allrice_storage_objects where id=${object.id}`.catch(
        () => null,
      );
    if (known?.length === 0)
      await storage
        .delete({ ...object, immutable: false })
        .catch(() => undefined);
    throw error;
  }
  return object;
}
/** One browser I/O controller attached to the EXISTING Run Job; no Agent/model loop. */
export function startBrowserWorkspaceController(
  initial: BrowserWorkspaceRow,
  options: {
    storage: StoragePort;
    signal?: AbortSignal;
    database?: Database;
    driver?: typeof startBrowserControlDriver;
  },
): BrowserController {
  if (!initial.task_id) throw Error('BROWSER_CLOUD_TARGET_REQUIRED');
  const taskId = initial.task_id;
  if (activeControllers.has(initial.id))
    return ownedBrowserController(
      initial.id,
      initial.job_id,
      initial.worker_id,
    );
  const db = options.database ?? getDatabase(),
    ctx = browserPrincipal(initial.execution_context),
    ledger = createBrowserOperationLedger(ctx, db);
  let driver: BrowserDriver | undefined,
    active: Pending | null = null,
    failedAuthority = false,
    closing = false;
  let networkEffect = false,
    requestChecksPending = 0;
  const networkWaiting = new Set<Promise<void>>();
  const assertCurrent = async () => {
    if (closing || failedAuthority || options.signal?.aborted)
      throw Error('BROWSER_AUTHORITY_LOST');
    const w = await readCurrentBrowserWorkspace(ctx, initial.id, db);
    if (
      w.worker_id !== initial.worker_id ||
      w.job_lease_token !== initial.job_lease_token ||
      w.desired_control === 'closed'
    )
      throw Error('BROWSER_AUTHORITY_LOST');
    if (
      active &&
      (w.control_fence !== active.payload.fence ||
        w.acknowledged_fence !== active.payload.fence ||
        w.state !== active.payload.actor)
    )
      throw Error('BROWSER_CONTROL_CHANGED');
    return w;
  };
  async function finish(
    row: Pending,
    signal: RuntimeOperationSignal,
    output: Record<string, unknown>,
  ) {
    const evidence = {
        source: 'managed_browser_control',
        trusted: false,
        ...output,
      },
      receiptId = cloudStableId(`${row.operation_id}:outcome`);
    // Save exact receipt before ledger projection. Never retry a physical action.
    const saved = {
      scope: row.binding.task.scope,
      operationId: row.operation_id,
      leaseToken: row.lease_token!,
      attempt: row.binding.attempt,
      receiptId,
      signal,
      evidence,
    };
    await db`update allrice_browser_operation_inputs set result=${db.json(evidence)},receipt=${db.json(saved as never)} where operation_id=${row.operation_id} and result is null`;
    const [prior] = await db<
      { receipt: typeof saved }[]
    >`select receipt from allrice_browser_operation_inputs where operation_id=${row.operation_id}`;
    await ledger.recordReceipt(prior!.receipt);
  }
  const uncertain = (row: Pending, code: string) =>
    finish(
      row,
      { type: 'operation.uncertain', reason: 'receipt_missing' },
      { code, effects: 'unknown' },
    );
  async function outcome(
    row: Pending,
    output: Record<string, unknown>,
    success = true,
  ) {
    const evidence = {
      id: cloudStableId(`${row.operation_id}:evidence`),
      recordedAt: new Date().toISOString(),
      digest: digest(output),
    };
    return finish(
      row,
      {
        type: 'operation.outcome',
        result: {
          status: success ? 'succeeded' : 'failed',
          effects:
            success && row.payload.action.type !== 'observe'
              ? 'applied'
              : 'none',
          evidence,
        },
      },
      output,
    );
  }
  async function dispatch(row: Pending, wait: boolean) {
    // Persisted dispatch/start is never recovered into another physical action.
    if (row.lease_token || row.started_at) {
      if (!row.result && row.lease_token)
        await uncertain(row, 'BROWSER_NO_REPLAY');
      return false;
    }
    do {
      await assertCurrent();
      try {
        const lease = await ledger.dispatch({
          scope: row.binding.task.scope,
          operationId: row.operation_id,
          leaseOwner: initial.worker_id,
          leaseMs: 15000,
        });
        row.lease_token = lease.leaseToken;
        const start = await ledger.startOperation({
          scope: row.binding.task.scope,
          operationId: row.operation_id,
          leaseToken: lease.leaseToken,
          attempt: row.binding.attempt,
          receiptId: cloudStableId(`${row.operation_id}:start`),
        });
        if (!start.mayExecute) {
          await uncertain(row, 'BROWSER_NO_REPLAY');
          return false;
        }
        await db`update allrice_browser_operation_inputs set started_at=clock_timestamp() where operation_id=${row.operation_id} and started_at is null`;
        return true;
      } catch (error) {
        if (
          !['approval_required', 'approval_invalid_or_stale'].includes(
            error instanceof Error ? error.message : '',
          )
        )
          throw error;
        if (!wait) return false;
        const [a] = await db<
          { status: string; expires: Date; revoked: Date | null }[]
        >`select status,runtime_expires_at as expires,runtime_revoked_at as revoked from allrice_approval_requests
          where resource_type='runtime_operation' and resource_id=${row.operation_id}`;
        if (
          !a ||
          a.status === 'rejected' ||
          a.revoked ||
          a.expires.getTime() <= Date.now()
        )
          throw Error('BROWSER_APPROVAL_UNAVAILABLE');
        await delay(200);
      }
    } while (Date.now() < initial.expires_at.getTime());
    throw Error('BROWSER_DEADLINE');
  }
  async function requestApproval(effect: BrowserRequestEffect) {
    if (
      !active ||
      active.payload.action.type === 'observe' ||
      active.payload.action.type === 'request'
    )
      throw Error('BROWSER_UNOWNED_REQUEST');
    const parent = active;
    const created = await createBrowserOperation(
      ctx,
      {
        ...parent.payload,
        action: {
          type: 'request',
          parentOperationId: parent.operation_id,
          ...effect,
        },
      },
      randomUUID(),
      db,
      true,
    );
    const row: Pending = {
      operation_id: created.snapshot.binding.attempt.operationId,
      binding: created.snapshot.binding,
      payload: created.payload,
      observation: parent.observation,
      lease_token: null,
      started_at: null,
      result: null,
    };
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    networkWaiting.add(pending);
    try {
      if (!(await dispatch(row, true)))
        throw Error('BROWSER_REQUEST_NOT_AUTHORIZED');
      let settled = false;
      return {
        complete: async (confirmed: boolean) => {
          if (settled) return;
          settled = true;
          try {
            if (confirmed)
              await outcome(row, {
                transportCompleted: true,
                businessResult: 'inspect_page',
              });
            else await uncertain(row, 'BROWSER_REQUEST_UNCONFIRMED');
          } catch {
            failedAuthority = true;
          } finally {
            resolve();
            networkWaiting.delete(pending);
          }
        },
      };
    } catch (error) {
      resolve();
      networkWaiting.delete(pending);
      throw error;
    }
  }
  async function observe(w: BrowserWorkspaceRow, ack = false) {
    const capture = await driver!.observe(w.control_fence);
    const object = await persistBrowserCapture(
      w,
      options.storage,
      capture.screenshot,
      'screenshot',
      'browser-observation.png',
      'image/png',
    );
    const observation = {
      ...capture.observation,
      screenshotObjectId: object.id,
    };
    if (ack)
      await acknowledgeBrowserControl(
        ctx,
        w.id,
        w.control_fence,
        observation,
        db,
      );
    else await recordBrowserObservation(ctx, w.id, observation, db);
    await publishBrowserObservationArtifact(
      w,
      observation,
      options.storage,
      db,
    );
    return observation;
  }
  async function execute(row: Pending) {
    active = row;
    networkEffect = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let heartbeat: Promise<unknown> | undefined;
    const stopHeartbeat = async () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      await heartbeat?.catch(() => undefined);
    };
    try {
      if (!(await dispatch(row, false))) return;
      timer = setInterval(() => {
        if (heartbeat) return;
        heartbeat = (async () => {
          await assertCurrent();
          await ledger.heartbeat({
            scope: row.binding.task.scope,
            operationId: row.operation_id,
            leaseToken: row.lease_token!,
            leaseMs: 15000,
          });
        })()
          .catch(async (error) => {
            if (
              error instanceof Error &&
              error.message === 'BROWSER_CONTROL_CHANGED'
            )
              return;
            // The fence may change between the first check and the ledger's
            // locked check. Re-read the complete live authority before treating
            // that exact denial as a control handover, never as permission to
            // retry/continue the old action or as evidence of a physical stop.
            if (
              error instanceof Error &&
              error.message === 'browser_control_changed'
            ) {
              const current = await readCurrentBrowserWorkspace(
                ctx,
                initial.id,
                db,
              ).catch(() => null);
              if (
                current &&
                current.worker_id === initial.worker_id &&
                current.job_lease_token === initial.job_lease_token &&
                current.desired_control !== 'closed' &&
                current.control_fence !== row.payload.fence
              )
                return;
            }
            failedAuthority = true;
          })
          .finally(() => {
            heartbeat = undefined;
          });
      }, 500);
      const w = await assertCurrent();
      let bytes: Buffer | undefined;
      if (row.payload.action.type === 'sensitive_fill')
        bytes = await consumeBrowserDirectInput(ctx, w.id, row.payload, db);
      if (row.payload.action.type === 'upload') {
        const file = await getToolBrokerFile(
            initial.execution_context,
            row.payload.action.objectId,
          ),
          reader = (await options.storage.get(file.object)).getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > w.profile.maximumFileBytes) {
              await reader.cancel();
              throw Error('BROWSER_UPLOAD_TOO_LARGE');
            }
            parts.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
        bytes = Buffer.concat(parts);
      }
      const returned = await driver!
        .perform(row.payload.action, row.observation, bytes)
        .finally(() => bytes?.fill(0));
      // The renderer awaits the click's causal navigation signal; only requests
      // already owned by this exact action may extend its settlement.
      const networkDeadline = Math.min(
        initial.expires_at.getTime(),
        Date.now() + 120000,
      );
      while (
        (networkWaiting.size || requestChecksPending > 0) &&
        Date.now() < networkDeadline
      ) {
        await assertCurrent();
        await delay(100);
      }
      if (networkWaiting.size || requestChecksPending > 0)
        throw Error('BROWSER_REQUEST_UNCONFIRMED');
      await assertCurrent();
      const download = returned.download
        ? await persistBrowserCapture(
            w,
            options.storage,
            returned.download.bytes,
            'download',
            returned.download.name,
            returned.download.mediaType,
          )
        : null;
      // All native I/O has settled. Drain the old operation's lease renewal
      // BEFORE its terminal receipt; screenshots may take longer than a tick.
      // A terminal operation no longer owns a running lease to renew.
      await stopHeartbeat();
      await assertCurrent();
      await outcome(row, {
        completed: true,
        downloadObjectId: download?.id ?? null,
        networkRequestSent: networkEffect,
      });
      // Publish a new observation only AFTER the exact action's receipt is durable.
      const observation = await observe(await assertCurrent());
      if (
        observation.profileId !== row.payload.profileId ||
        observation.fence !== row.payload.fence ||
        observation.id === row.observation?.id
      )
        throw Error('BROWSER_OBSERVATION_CHANGED');
      // A workspace capture alone does not prove which action preceded it.
      // Record this causal link only after this action's terminal receipt and
      // its subsequent capture/publication, without mutating receipt evidence.
      const linked =
        await db`update allrice_browser_operation_inputs set result_observation_id=${observation.id}
        where operation_id=${row.operation_id} and browser_workspace_id=${initial.id}
        and lease_token=${row.lease_token!} and result is not null and receipt is not null
        and result_observation_id is null
        and exists(select 1 from allrice_runtime_operations o where o.id=${row.operation_id} and o.snapshot->>'status'='succeeded')
        returning operation_id`;
      if (!linked.length) throw Error('BROWSER_OBSERVATION_UNCONFIRMED');
    } catch (error) {
      await stopHeartbeat();
      if (row.lease_token)
        await uncertain(
          row,
          error instanceof Error && /^BROWSER_[A-Z_]+$/.test(error.message)
            ? error.message
            : 'BROWSER_UNCONFIRMED',
        ).catch(() => undefined);
    } finally {
      await stopHeartbeat();
      active = null;
    }
  }
  const closed = (async () => {
    let physicallyClosed = false;
    let terminalReason = 'BROWSER_CONTROL_CLOSED';
    try {
      driver = await (options.driver ?? startBrowserControlDriver)({
        profileId: initial.profile_id,
        profile: initial.profile,
        assertCurrent: async () => {
          await assertCurrent();
        },
        requestApproval,
        requestStarted: () => {
          requestChecksPending++;
          let settled = false;
          return () => {
            if (!settled) {
              settled = true;
              requestChecksPending--;
            }
          };
        },
        requestSent: () => {
          networkEffect = true;
        },
      });
      await acknowledgeBrowserControl(
        ctx,
        initial.id,
        initial.control_fence,
        null,
        db,
      );
      while (
        !options.signal?.aborted &&
        !failedAuthority &&
        Date.now() < initial.expires_at.getTime()
      ) {
        const w = await assertCurrent();
        if (w.acknowledged_fence !== w.control_fence) {
          await observe(w, true);
          continue;
        }
        if (w.state === 'paused') {
          await delay(200);
          continue;
        }
        const [row] = await db<
          Pending[]
        >`select i.* from allrice_browser_operation_inputs i join allrice_runtime_operations o on o.id=i.operation_id
          where i.browser_workspace_id=${w.id} and i.result is null and i.payload->'action'->>'type'<>'request'
          and (i.payload->>'fence')::integer=${w.control_fence} and i.payload->>'actor'=${w.state}
          and not exists(select 1 from allrice_approval_requests a where a.resource_type='runtime_operation' and a.resource_id=i.operation_id
            and (a.status='rejected' or a.runtime_revoked_at is not null or a.runtime_expires_at<=clock_timestamp()))
          and o.snapshot->>'status' in ('ready','waiting_user','dispatched','running') order by i.created_at limit 1`;
        if (row) {
          row.payload = BrowserCommandSchema.parse(row.payload);
          row.binding = RuntimeOperationSnapshotSchema.parse(
            await ledger.readOperation(
              {
                organizationId: w.organization_id,
                workspaceId: w.workspace_id,
                projectId: null,
              },
              row.operation_id,
            ),
          ).binding;
          await execute(row);
        }
        await delay(150);
      }
    } catch (error) {
      // Stable code only: never persist a page, URL, request body or credential error.
      terminalReason =
        error instanceof Error &&
        /^(?:BROWSER_[A-Z_]+|browser_[a-z_]+)$/.test(error.message)
          ? error.message.toUpperCase()
          : 'BROWSER_CONTROLLER_UNCONFIRMED';
    } finally {
      closing = true;
      try {
        await Promise.race([
          driver?.close(),
          delay(10000).then(() => {
            throw Error('BROWSER_STOP_UNCONFIRMED');
          }),
        ]);
        physicallyClosed = !!driver;
      } catch {
        /* Do not acknowledge stop unless physical close succeeded. */
      }
      await recordBrowserStopped(
        initial.id,
        initial.worker_id,
        initial.job_lease_token,
        physicallyClosed,
        db,
      ).catch(() => undefined);
      await db`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
        values(${initial.organization_id},${initial.workspace_id},${initial.owner_id},'browser.controller.closed','browser_workspace',${initial.id},'recorded',${terminalReason},
          ${db.json({ physicalStopConfirmed: physicallyClosed, workerId: initial.worker_id })})`.catch(
        () => undefined,
      );
      await completeManagedBrowserTask({
        context: initial.execution_context,
        lease: {
          attempt: initial.job_attempt,
          leaseToken: initial.job_lease_token,
        },
        taskId,
        status: physicallyClosed ? 'canceled' : 'failed',
        errorCode: physicallyClosed
          ? terminalReason
          : 'BROWSER_STOP_UNCONFIRMED',
      }).catch(() => undefined);
      activeControllers.delete(initial.id);
    }
  })();
  const controller = {
    workspaceId: initial.id,
    jobId: initial.job_id,
    workerId: initial.worker_id,
    closed,
  };
  activeControllers.set(initial.id, controller);
  return controller;
}
export async function waitBrowserOperationResult(
  ctx: ReturnType<typeof browserPrincipal>,
  workspaceId: string,
  operationId: string,
  db = getDatabase(),
  signal?: AbortSignal,
) {
  let captureDeadline: number | undefined;
  while (!signal?.aborted) {
    const w = await readCurrentBrowserWorkspace(ctx, workspaceId, db);
    const [op] = await db<
      {
        result: unknown;
        snapshot: unknown;
        observation_id: string | null;
        result_observation_id: string | null;
        receipt_observation_id: string | null;
        lease_token: string | null;
        started_at: Date | null;
        approval_status: string | null;
        approval_expired: boolean;
        approval_revoked: boolean;
      }[]
    >`select i.result,o.snapshot,i.observation->>'id' as observation_id,i.result_observation_id,
      i.receipt->'evidence'->>'observationId' as receipt_observation_id,i.lease_token,i.started_at,
      a.status as approval_status,a.runtime_expires_at<=clock_timestamp() as approval_expired,a.runtime_revoked_at is not null as approval_revoked
      from allrice_browser_operation_inputs i join allrice_runtime_operations o on o.id=i.operation_id
      left join allrice_approval_requests a on a.resource_type='runtime_operation' and a.resource_id=i.operation_id
      where i.operation_id=${operationId} and i.browser_workspace_id=${workspaceId}`;
    if (!op) throw Error('BROWSER_OPERATION_UNAVAILABLE');
    const snapshot = RuntimeOperationSnapshotSchema.parse(op.snapshot);
    if (
      !op.result &&
      !op.lease_token &&
      !op.started_at &&
      snapshot.status === 'waiting_user' &&
      (op.approval_status === 'rejected' ||
        op.approval_expired ||
        op.approval_revoked)
    )
      return {
        operationId,
        status: snapshot.status,
        result: {
          completed: false,
          code: 'BROWSER_APPROVAL_UNAVAILABLE',
          effects: 'none',
        },
        approvalStatus: op.approval_status,
        observation: null,
        observationRefreshRequired: true,
        untrustedExternalContent: true,
      };
    if (op.result) {
      // finish() persists a recoverable receipt before projecting the ledger.
      // Prepared output alone is not a completed action: wait for the exact
      // operation's durable outcome/uncertainty, under the same abort/current
      // workspace authority bounds as the rest of this wait.
      if (
        !isTerminalRuntimeOperationStatus(snapshot.status) &&
        snapshot.status !== 'unknown'
      ) {
        await delay(100);
        continue;
      }
      // Local receipts already bind a validated capture ID into their evidence;
      // cloud capture follows the terminal receipt and has its own write-once
      // correlation. A null input ID (navigate/open) is never a freshness proof.
      const resultingObservationId =
        w.transport === 'local'
          ? op.receipt_observation_id
          : op.result_observation_id;
      const fresh =
        w.observation &&
        w.observation.id === resultingObservationId &&
        w.observation.id !== op.observation_id
          ? w.observation
          : null;
      captureDeadline ??= Date.now() + 5000;
      if (
        snapshot.status === 'succeeded' &&
        !fresh &&
        Date.now() < captureDeadline
      ) {
        await delay(100);
        continue;
      }
      return {
        operationId,
        status: snapshot.status,
        result: op.result,
        observation: fresh,
        observationRefreshRequired: !fresh,
        untrustedExternalContent: true,
      };
    }
    await delay(200);
  }
  throw Error('BROWSER_CANCELED');
}
