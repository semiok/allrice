import { randomUUID } from 'node:crypto';
import {
  BrowserCommandSchema,
  BrowserObservationSchema,
  LocalBrowserOperationSchema,
  LocalBrowserStartSchema,
  RuntimeOperationSnapshotSchema,
  runtimeContractEqual,
  UuidSchema,
  type BridgeDevice,
  type BrowserObservation,
  type LocalBrowserReceipt,
  type LocalBrowserRequestEffect,
  type RuntimeOperationSignal,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  createBrowserOperation,
  createBrowserOperationLedger,
  acknowledgeBrowserControl,
} from './browser-control.ts';
import { checkBrowserBindingAuthority } from './browser-control-authority.ts';
import { cloudStableId } from './cloud-execution.ts';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';
import {
  lockLocalBrowserController,
  type LocalControllerIdentity,
} from './local-browser-workspaces.ts';
import { localBrowserPrincipal } from './local-browser-grants.ts';

type OperationRow = {
  snapshot: unknown;
  payload: unknown;
  observation: unknown;
  lease_token: string | null;
  started_at: Date | null;
  result: unknown;
  receipt: unknown;
};
export async function ownedLocalBrowserOperation(
  device: BridgeDevice,
  input: LocalControllerIdentity & {
    operationId: string;
    operationLeaseToken?: string;
  },
  admit = true,
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    const current = await lockLocalBrowserController(tx, device, input, admit);
    const [row] = await tx<
      OperationRow[]
    >`select o.snapshot,i.payload,i.observation,i.lease_token,i.started_at,i.result,i.receipt
      from allrice_browser_operation_inputs i join allrice_runtime_operations o on o.id=i.operation_id
      where i.operation_id=${UuidSchema.parse(input.operationId)} and i.browser_workspace_id=${input.workspaceId}
        and o.organization_id=${device.organizationId} and o.workspace_id=${device.workspaceId} and o.device_id=${device.id}`;
    if (!row) throw new RuntimePolicyError('local_browser_operation_denied');
    if (
      input.operationLeaseToken !== undefined &&
      row.lease_token !== input.operationLeaseToken
    )
      throw new RuntimePolicyError('local_browser_operation_lease_lost');
    const snapshot = RuntimeOperationSnapshotSchema.parse(row.snapshot),
      command = BrowserCommandSchema.parse(row.payload);
    if (admit)
      await checkBrowserBindingAuthority(
        tx,
        localBrowserPrincipal(device),
        snapshot.binding,
      );
    return { ...current, row, snapshot, command };
  });
}

export async function nextLocalBrowserOperation(
  device: BridgeDevice,
  input: LocalControllerIdentity,
  db = getDatabase(),
) {
  const { workspace: w } = await db.begin((tx) =>
    lockLocalBrowserController(tx, device, input),
  );
  const [row] = await db<
    OperationRow[]
  >`select o.snapshot,i.payload,i.observation from allrice_browser_operation_inputs i
    join allrice_runtime_operations o on o.id=i.operation_id where i.browser_workspace_id=${w.id}
      and i.result is null and i.lease_token is null and i.payload->'action'->>'type'<>'request'
      and i.payload->>'actor'=${w.state} and (i.payload->>'fence')::integer=${w.control_fence}
      and not exists (select 1 from allrice_approval_requests a where a.resource_type='runtime_operation' and a.resource_id=i.operation_id
        and (a.status='rejected' or a.runtime_revoked_at is not null or a.runtime_expires_at<=clock_timestamp()))
      and o.snapshot->>'status' in ('ready','waiting_user') order by i.created_at,i.operation_id limit 1`;
  return {
    operation: row
      ? LocalBrowserOperationSchema.parse({
          snapshot: row.snapshot,
          command: row.payload,
          observation: row.observation,
        })
      : null,
  };
}

export async function startLocalBrowserOperation(
  device: BridgeDevice,
  input: LocalControllerIdentity & { operationId: string },
  db = getDatabase(),
) {
  const current = await ownedLocalBrowserOperation(device, input, true, db);
  const ledger = createBrowserOperationLedger(
    localBrowserPrincipal(device),
    db,
  );
  const scope = current.snapshot.binding.task.scope;
  if (
    current.row.started_at ||
    current.snapshot.status === 'running' ||
    current.row.result
  )
    return LocalBrowserStartSchema.parse({
      snapshot: current.snapshot,
      mayExecute: false,
      operationLeaseToken: current.row.lease_token,
    });
  let token = current.row.lease_token;
  if (!token) {
    try {
      const lease = await ledger.dispatch({
        scope,
        operationId: input.operationId,
        leaseOwner: device.id,
        leaseMs: 5000,
      });
      token = lease.leaseToken;
    } catch (error) {
      if (
        error instanceof RuntimePolicyError &&
        ['approval_required', 'approval_invalid_or_stale'].includes(error.code)
      )
        return LocalBrowserStartSchema.parse({
          snapshot: current.snapshot,
          mayExecute: false,
          operationLeaseToken: null,
        });
      throw error;
    }
  }
  const started = await ledger.startOperation({
    scope,
    operationId: input.operationId,
    leaseToken: token,
    attempt: current.snapshot.binding.attempt,
    receiptId: cloudStableId(`${input.operationId}:local-browser-start`),
  });
  if (started.mayExecute)
    await db`update allrice_browser_operation_inputs set started_at=clock_timestamp() where operation_id=${input.operationId} and started_at is null`;
  return LocalBrowserStartSchema.parse({
    ...started,
    operationLeaseToken: token,
  });
}

export async function renewLocalBrowserOperations(
  device: BridgeDevice,
  input: LocalControllerIdentity,
  db = getDatabase(),
) {
  const ledger = createBrowserOperationLedger(
    localBrowserPrincipal(device),
    db,
  );
  const rows = await db<
    { operation_id: string; lease_token: string }[]
  >`select i.operation_id,i.lease_token
    from allrice_browser_operation_inputs i join allrice_runtime_operations o on o.id=i.operation_id
    where i.browser_workspace_id=${input.workspaceId} and i.lease_token is not null and i.result is null and o.snapshot->>'status' in ('dispatched','running') limit 64`;
  for (const row of rows) {
    try {
      const current = await ownedLocalBrowserOperation(
        device,
        {
          ...input,
          operationId: row.operation_id,
          operationLeaseToken: row.lease_token,
        },
        true,
        db,
      );
      await ledger.heartbeat({
        scope: current.snapshot.binding.task.scope,
        operationId: row.operation_id,
        leaseToken: row.lease_token,
        leaseMs: 5000,
      });
    } catch (error) {
      // A control fence change invalidates the old action, not the new control
      // handshake. The device receives the changed fence and settles its I/O.
      if (
        error instanceof RuntimePolicyError &&
        [
          'browser_control_changed',
          'browser_observation_stale',
          'browser_authority_unavailable',
        ].includes(error.code)
      )
        continue;
      throw error;
    }
  }
}

export async function recordLocalBrowserReceipt(
  device: BridgeDevice,
  input: LocalBrowserReceipt,
  db = getDatabase(),
) {
  const current = await ownedLocalBrowserOperation(device, input, false, db);
  if (!current.row.started_at)
    throw new RuntimePolicyError('local_browser_not_started');
  const requestDigest = digest(input);
  const saved = await db.begin(async (tx) => {
    await lockLocalBrowserController(tx, device, input, false);
    const [row] = await tx<
      { receipt: unknown; result: { requestDigest?: string } | null }[]
    >`select receipt,result from allrice_browser_operation_inputs where operation_id=${input.operationId} for update`;
    if (row?.receipt) {
      if (row.result?.requestDigest !== requestDigest)
        throw new RuntimePolicyError('local_browser_receipt_conflict');
      return row.receipt;
    }
    if (input.downloadObjectId) {
      const [file] =
        await tx`select object_id from allrice_local_browser_captures
        where browser_workspace_id=${input.workspaceId} and operation_id=${input.operationId} and kind='download' and object_id=${input.downloadObjectId}`;
      if (!file) throw new RuntimePolicyError('local_browser_capture_denied');
    }
    if (input.observationId) {
      const [capture] =
        await tx`select id from allrice_local_browser_captures where browser_workspace_id=${input.workspaceId}
        and observation_id=${input.observationId} and kind='screenshot'`;
      if (!capture)
        throw new RuntimePolicyError('local_browser_capture_denied');
    }
    const output = {
      source: 'local_browser',
      trusted: false,
      status: input.status,
      networkRequestSent: input.networkEffect,
      observationId: input.observationId,
      downloadObjectId: input.downloadObjectId,
      errorCode: input.errorCode,
      requestDigest,
    };
    const signal: RuntimeOperationSignal =
      input.status === 'unknown'
        ? { type: 'operation.uncertain', reason: 'receipt_missing' }
        : {
            type: 'operation.outcome',
            result: {
              status: input.status,
              effects:
                input.status === 'succeeded' &&
                current.command.action.type !== 'observe'
                  ? 'applied'
                  : input.networkEffect
                    ? 'partial'
                    : 'none',
              evidence: {
                id: randomUUID(),
                recordedAt: new Date().toISOString(),
                digest: digest(output),
              },
            },
          };
    const receipt = {
      scope: current.snapshot.binding.task.scope,
      operationId: input.operationId,
      leaseToken: input.operationLeaseToken,
      attempt: current.snapshot.binding.attempt,
      receiptId: input.receiptId,
      signal,
      evidence: output,
    };
    await tx`update allrice_browser_operation_inputs set result=${tx.json(output)},receipt=${tx.json(receipt as never)} where operation_id=${input.operationId}`;
    return receipt;
  });
  const ledger = createBrowserOperationLedger(
    localBrowserPrincipal(device),
    db,
  );
  await ledger.recordReceipt(
    saved as Parameters<typeof ledger.recordReceipt>[0],
  );
  return { ok: true };
}

export async function publishLocalBrowserObservation(
  device: BridgeDevice,
  input: LocalControllerIdentity & { observation: BrowserObservation },
  db = getDatabase(),
) {
  const observation = BrowserObservationSchema.parse(input.observation);
  await db.begin(async (tx) => {
    const { workspace: w } = await lockLocalBrowserController(
      tx,
      device,
      input,
    );
    if (
      observation.profileId !== w.profile_id ||
      observation.fence !== w.control_fence ||
      Date.parse(observation.capturedAt) > w.clock.getTime() + 1000 ||
      Date.parse(observation.expiresAt) <= w.clock.getTime() ||
      Date.parse(observation.expiresAt) - Date.parse(observation.capturedAt) >
        60000
    )
      throw new RuntimePolicyError('browser_observation_stale');
    const [capture] =
      await tx`select object_id from allrice_local_browser_captures where browser_workspace_id=${w.id}
      and fence=${observation.fence} and observation_id=${observation.id} and kind='screenshot' and object_id=${observation.screenshotObjectId}`;
    if (!capture) throw new RuntimePolicyError('local_browser_capture_denied');
    if (
      w.observation &&
      observation.revision <= w.observation.revision &&
      !runtimeContractEqual(w.observation, observation)
    )
      throw new RuntimePolicyError('browser_observation_stale');
    const updated =
      await tx`update allrice_browser_workspaces set observation=${tx.json(observation)},last_heartbeat_at=clock_timestamp()
      where id=${w.id} and control_fence=${observation.fence}
        and (observation is null or (observation->>'revision')::integer<${observation.revision} or observation=${tx.json(observation)}) returning id`;
    if (!updated.length)
      throw new RuntimePolicyError('browser_observation_stale');
  });
  return { ok: true };
}

export async function acknowledgeLocalBrowserControl(
  device: BridgeDevice,
  input: LocalControllerIdentity & {
    fence: number;
    state: string;
    observationId: string | null;
  },
  db = getDatabase(),
) {
  const { workspace: w } = await db.begin((tx) =>
    lockLocalBrowserController(tx, device, input),
  );
  if (
    input.fence !== w.control_fence ||
    input.state !== w.desired_control ||
    input.state === 'closed'
  )
    throw new RuntimePolicyError('browser_control_changed');
  const observation = w.observation;
  if (
    !observation ||
    input.observationId !== observation.id ||
    observation.fence !== input.fence
  )
    throw new RuntimePolicyError('browser_observation_stale');
  await acknowledgeBrowserControl(
    localBrowserPrincipal(device),
    w.id,
    input.fence,
    observation,
    db,
  );
  return { ok: true };
}

export async function requestLocalBrowserEffect(
  device: BridgeDevice,
  input: LocalControllerIdentity & {
    operationId: string;
    operationLeaseToken: string;
    requestId: string;
    effect: LocalBrowserRequestEffect;
  },
  db = getDatabase(),
) {
  const parent = await ownedLocalBrowserOperation(device, input, true, db);
  if (
    parent.snapshot.status !== 'running' ||
    !parent.row.started_at ||
    ['request', 'observe'].includes(parent.command.action.type)
  )
    throw new RuntimePolicyError('browser_request_parent_unavailable');
  const operation = await createBrowserOperation(
    localBrowserPrincipal(device),
    {
      ...parent.command,
      action: {
        type: 'request',
        parentOperationId: input.operationId,
        ...input.effect,
      },
    },
    UuidSchema.parse(input.requestId),
    db,
    true,
  );
  return {
    operationId: operation.snapshot.binding.attempt.operationId,
    status: 'pending' as const,
    permissionToken: null,
  };
}

export async function localBrowserEffectStatus(
  device: BridgeDevice,
  input: LocalControllerIdentity & {
    operationId: string;
    approvalOperationId: string;
  },
  db = getDatabase(),
) {
  const effect = await ownedLocalBrowserOperation(
    device,
    { ...input, operationId: input.approvalOperationId },
    true,
    db,
  );
  if (
    effect.command.action.type !== 'request' ||
    effect.command.action.parentOperationId !== input.operationId
  )
    throw new RuntimePolicyError('browser_request_parent_unavailable');
  const [denied] =
    await db`select id from allrice_approval_requests where resource_type='runtime_operation' and resource_id=${input.approvalOperationId}
    and (status='rejected' or runtime_revoked_at is not null or runtime_expires_at<=clock_timestamp())`;
  if (denied)
    return {
      operationId: input.approvalOperationId,
      status: 'denied' as const,
      permissionToken: null,
    };
  const started = await startLocalBrowserOperation(
    device,
    { ...input, operationId: input.approvalOperationId },
    db,
  );
  return {
    operationId: input.approvalOperationId,
    status: started.mayExecute
      ? ('ready' as const)
      : effect.row.started_at
        ? ('unknown' as const)
        : ('pending' as const),
    permissionToken: started.mayExecute ? started.operationLeaseToken : null,
  };
}

export async function completeLocalBrowserEffect(
  device: BridgeDevice,
  input: LocalControllerIdentity & {
    approvalOperationId: string;
    permissionToken: string;
    confirmed: boolean;
  },
  db = getDatabase(),
) {
  const effect = await ownedLocalBrowserOperation(
    device,
    {
      ...input,
      operationId: input.approvalOperationId,
      operationLeaseToken: input.permissionToken,
    },
    false,
    db,
  );
  if (effect.command.action.type !== 'request')
    throw new RuntimePolicyError('browser_request_parent_unavailable');
  return recordLocalBrowserReceipt(
    device,
    {
      ...input,
      operationId: input.approvalOperationId,
      operationLeaseToken: input.permissionToken,
      receiptId: cloudStableId(
        `${input.approvalOperationId}:local-request-complete`,
      ),
      status: input.confirmed ? 'succeeded' : 'unknown',
      networkEffect: true,
      observationId: null,
      downloadObjectId: null,
      errorCode: input.confirmed ? null : 'LOCAL_BROWSER_IO_UNKNOWN',
    },
    db,
  );
}
