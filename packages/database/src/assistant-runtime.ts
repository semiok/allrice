import { randomUUID } from 'node:crypto';
import {
  AssistantMessageRequestSchema,
  AssistantResultSchema,
  AssistantRunConfigurationSchema,
  RuntimeTaskRefSchema,
  type AssistantInstanceView,
  type AssistantMessageStatus,
  type AssistantResult,
  type AssistantRunConfiguration,
  type AssistantStatus,
  type RequestContext,
  type RuntimeTaskRef,
  type RuntimeScope,
} from '@allrice/contracts';
import { z } from 'zod';
import { getDatabase } from './core/client.ts';
import {
  runtimeLedgerInputDigest,
  cancelRuntimeAgentOperationsTransaction,
} from './runtime-ledger/ledger.ts';
import type { RuntimeLedgerTransaction } from './runtime-ledger/types.ts';

type Tx = RuntimeLedgerTransaction;
const json = (tx: Tx, value: unknown) =>
  tx.json(JSON.parse(JSON.stringify(value)));
const uuid = z.uuid();
const toolsSchema = z
  .array(z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/))
  .max(64);
const amountsSchema = z.partialRecord(
  z.enum([
    'model_calls',
    'tool_calls',
    'input_tokens',
    'output_tokens',
    'wall_time',
    'cost',
  ]),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
);
const terminal = new Set<AssistantStatus>([
  'completed',
  'partial',
  'failed',
  'canceled',
]);
export const assistantRuntimeEnabled = () =>
  process.env.ALLRICE_ASSISTANTS_ENABLED === '1';
export class AssistantRuntimeError extends Error {
  constructor(
    public readonly code:
      | 'disabled'
      | 'forbidden'
      | 'conflict'
      | 'canceled'
      | 'lease_lost'
      | 'limit_exceeded'
      | 'budget_exhausted'
      | 'unknown'
      | 'not_found',
  ) {
    super(code);
  }
}
function fail(code: AssistantRuntimeError['code']): never {
  throw new AssistantRuntimeError(code);
}
export interface AssistantWorkerLease {
  jobId: string;
  workerId: string;
  leaseToken: string;
  generation: number;
  fence?: number;
}
export interface AssistantAuthorityInput {
  transaction: Tx;
  task: RuntimeTaskRef;
  tools: string[];
  phase:
    | 'configure'
    | 'delegate'
    | 'message'
    | 'model'
    | 'tool'
    | 'recover'
    | 'proposal';
}
interface Root {
  root_run_id: string;
  task: RuntimeTaskRef;
  deadline_at: Date;
  cancel_request_id: string | null;
  configuration: AssistantRunConfiguration;
  worker_job_id: string;
  worker_id: string;
  generation: string;
  fence: string;
  revoked_at: Date | null;
}
interface Instance {
  run_id: string;
  root_run_id: string;
  parent_run_id: string | null;
  native_session_id: string;
  delegation_id: string;
  creation_digest: string;
  label: string;
  depth: number;
  allowed_tools: string[];
  artifact_namespace: string;
  status: AssistantStatus;
  cancel_requested_at: Date | null;
  stopped_at: Date | null;
}
interface Message {
  input_id: string;
  root_run_id: string;
  sender_run_id: string;
  recipient_run_id: string;
  content: string;
  content_digest: string;
  native_message_id: string | null;
  durable_seq: string | null;
  adopted_seq: string | null;
  status: AssistantMessageStatus;
}
const view = (i: Instance): AssistantInstanceView => ({
  runId: i.run_id,
  rootRunId: i.root_run_id,
  parentRunId: i.parent_run_id,
  nativeSessionId: i.native_session_id,
  label: i.label,
  depth: i.depth,
  status: i.status,
  allowedTools: i.allowed_tools,
  artifactNamespace: i.artifact_namespace,
  cancelRequestedAt: i.cancel_requested_at?.toISOString() ?? null,
  stoppedAt: i.stopped_at?.toISOString() ?? null,
});
const messageView = (m: Message) => ({
  inputId: m.input_id,
  senderRunId: m.sender_run_id,
  childRunId: m.recipient_run_id,
  text: m.content,
  status: m.status,
  nativeMessageId: m.native_message_id,
  durableSeq: m.durable_seq === null ? null : Number(m.durable_seq),
  adoptedSeq: m.adopted_seq === null ? null : Number(m.adopted_seq),
});
function enabled() {
  if (!assistantRuntimeEnabled()) fail('disabled');
}

/** Same durable cutoff for user cancellation, budget exhaustion and queue API.
 * Must lock the shared root before job/instance rows, matching model admission. */
export async function cancelAssistantRootTransaction(
  tx: Tx,
  rootRunId: string,
  requestId: string,
  reason: 'user_request' | 'budget_exhausted' = 'user_request',
) {
  uuid.parse(rootRunId);
  uuid.parse(requestId);
  const [root] =
    await tx`select root_run_id from allrice_runtime_roots where root_run_id=${rootRunId} for update`;
  if (!root) return;
  await tx`update allrice_runtime_roots set cancel_request_id=coalesce(cancel_request_id,${requestId}),cancel_reason=coalesce(cancel_reason,${reason}),cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()) where root_run_id=${rootRunId}`;
  await tx`update allrice_assistant_instances set cancel_request_id=coalesce(cancel_request_id,${requestId}),cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),status=case when status in ('completed','partial','failed','canceled') then status else 'cancel_requested' end where root_run_id=${rootRunId}`;
  await tx`update allrice_assistant_messages set status='canceled' where root_run_id=${rootRunId} and status='pending'`;
  await cancelRuntimeAgentOperationsTransaction(tx, rootRunId, requestId);
}

/** Mandatory trusted authority hook resolves current grants; IDs/tools from a
 * model never establish authority. Browser methods additionally verify owner and
 * active membership against PostgreSQL, not RequestContext membership claims. */
export function createAssistantRuntime(
  options: {
    database?: ReturnType<typeof getDatabase>;
    authorize?: (input: AssistantAuthorityInput) => Promise<void>;
  } = {},
) {
  const db = options.database ?? getDatabase();
  const authorize = options.authorize ?? (async () => fail('forbidden'));
  async function lock(
    tx: Tx,
    scope: RuntimeScope,
    rootRunId: string,
  ): Promise<Root> {
    uuid.parse(rootRunId);
    const [root] = await tx<
      Root[]
    >`select r.*, a.configuration,a.worker_job_id,a.worker_id,a.generation,a.fence,a.revoked_at
      from allrice_runtime_roots r join allrice_assistant_roots a using(root_run_id)
      where r.root_run_id=${rootRunId} and r.organization_id=${scope.organizationId} and r.workspace_id=${scope.workspaceId}
      for update of r,a`;
    if (!root || root.task.scope.projectId !== scope.projectId)
      fail('not_found');
    root.task = RuntimeTaskRefSchema.parse(root.task);
    root.configuration = AssistantRunConfigurationSchema.parse(
      root.configuration,
    );
    return root;
  }
  async function assertLease(
    tx: Tx,
    root: Root,
    lease: AssistantWorkerLease,
    admitting = true,
  ) {
    const [job] =
      await tx`select j.id from allrice_jobs j join allrice_runs r on r.id=j.run_id
      where j.id=${lease.jobId} and j.run_id=${root.root_run_id}
      and j.worker_id=${lease.workerId} and j.lease_token=${lease.leaseToken}
      and j.status='running' and j.lease_expires_at>clock_timestamp() and (${admitting}::boolean=false or j.cancel_requested_at is null)
      and r.state in ('running','queued','waiting_approval') for share of j,r`;
    if (
      !job ||
      root.worker_job_id !== lease.jobId ||
      root.worker_id !== lease.workerId ||
      Number(root.generation) !== lease.generation ||
      Number(root.fence) !== (lease.fence ?? 1) ||
      root.revoked_at
    )
      fail('lease_lost');
    if (admitting) {
      enabled();
      if (root.cancel_request_id) fail('canceled');
      const [at] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
      if (root.deadline_at <= at!.now) fail('budget_exhausted');
      if (!root.configuration.allowAssistants) fail('disabled');
    }
  }
  async function instance(tx: Tx, root: Root, runId: string) {
    uuid.parse(runId);
    const [row] = await tx<
      Instance[]
    >`select * from allrice_assistant_instances where run_id=${runId} and root_run_id=${root.root_run_id} for update`;
    if (!row) fail('not_found');
    return row;
  }
  async function active(tx: Tx, root: Root, runId: string) {
    const row = await instance(tx, root, runId);
    const ancestors = await tx<
      { status: AssistantStatus; cancel_requested_at: Date | null }[]
    >`
      with recursive lineage as (
        select * from allrice_assistant_instances where run_id=${runId}
        union all select p.* from allrice_assistant_instances p join lineage c on c.parent_run_id=p.run_id
      ) select status,cancel_requested_at from lineage`;
    if (ancestors.some((a) => a.cancel_requested_at || terminal.has(a.status)))
      fail('canceled');
    if (ancestors.some((a) => a.status === 'unknown')) fail('unknown');
    return row;
  }
  function taskFor(root: Root, row: Instance): RuntimeTaskRef {
    return { ...root.task, runId: row.run_id, parentRunId: row.parent_run_id };
  }
  async function owner(tx: Tx, context: RequestContext, runId: string) {
    uuid.parse(runId);
    if (context.actor.type !== 'user') fail('forbidden');
    const [row] = await tx<{ task: RuntimeTaskRef }[]>`
      select r.task from allrice_runtime_roots r join allrice_runs u on u.id=r.root_run_id
      where r.root_run_id=${runId} and r.organization_id=${context.organizationId} and r.workspace_id=${context.workspaceId}
      and u.owner_id=${context.actor.id} and exists(select 1 from allrice_memberships m
        where m.organization_id=r.organization_id and m.workspace_id=r.workspace_id and m.user_id=${context.actor.id} and m.active=true)`;
    if (!row) fail('not_found');
    return lock(tx, row.task.scope, runId);
  }
  async function queue(
    tx: Tx,
    root: Root,
    sender: Instance,
    child: Instance,
    inputId: string,
    text: string,
  ) {
    uuid.parse(inputId);
    const digest = runtimeLedgerInputDigest({
      sender: sender.run_id,
      recipient: child.run_id,
      text,
    });
    const [existing] = await tx<
      Message[]
    >`select * from allrice_assistant_messages where input_id=${inputId}`;
    if (existing) {
      if (
        existing.root_run_id !== root.root_run_id ||
        existing.content_digest !== digest
      )
        fail('conflict');
      return messageView(existing);
    }
    const [message] = await tx<
      Message[]
    >`insert into allrice_assistant_messages(input_id,root_run_id,sender_run_id,recipient_run_id,content,content_digest,status)
      values(${inputId},${root.root_run_id},${sender.run_id},${child.run_id},${text},${digest},'pending') returning *`;
    return messageView(message!);
  }

  const api = {
    async getSessionTrees(
      context: RequestContext,
      input: { sessionId: string; beforeRootRunId?: string },
    ) {
      uuid.parse(input.sessionId);
      if (context.actor.type !== 'user') fail('forbidden');
      const [session] =
        await db`select 1 from allrice_chat_sessions s where s.id=${input.sessionId} and s.organization_id=${context.organizationId} and s.workspace_id=${context.workspaceId} and s.owner_id=${context.actor.id} and exists(select 1 from allrice_memberships m where m.organization_id=s.organization_id and m.workspace_id=s.workspace_id and m.user_id=${context.actor.id} and m.active=true)`;
      if (!session) fail('not_found');
      if (input.beforeRootRunId) uuid.parse(input.beforeRootRunId);
      const roots = await db<
        { root_run_id: string }[]
      >`select r.root_run_id from allrice_runtime_roots r join allrice_assistant_roots a using(root_run_id) where r.organization_id=${context.organizationId} and r.workspace_id=${context.workspaceId} and r.task->>'chatSessionId'=${input.sessionId}
        and (${input.beforeRootRunId ?? null}::uuid is null or (a.created_at,a.root_run_id)<(select created_at,root_run_id from allrice_assistant_roots where root_run_id=${input.beforeRootRunId ?? null}))
        order by a.created_at desc,a.root_run_id desc limit 20`;
      return Promise.all(
        roots.map(async (r) => {
          const tree = await api.getTree(context, { runId: r.root_run_id });
          return {
            ...tree,
            messages: [],
            results: [],
            messageCount: tree.messages.length,
            resultCount: tree.results.length,
          };
        }),
      );
    },
    async configureRoot(input: {
      task: RuntimeTaskRef;
      configuration: AssistantRunConfiguration;
      nativeSessionId: string;
      worker: AssistantWorkerLease;
      allowedTools: string[];
    }) {
      enabled();
      const task = RuntimeTaskRefSchema.parse(input.task),
        configuration = AssistantRunConfigurationSchema.parse(
          input.configuration,
        );
      const allowedTools = [
        ...new Set(toolsSchema.parse(input.allowedTools)),
      ].sort();
      z.string()
        .regex(/^[a-zA-Z0-9_.-]{1,200}$/)
        .parse(input.nativeSessionId);
      if (task.runId !== task.rootRunId || task.parentRunId !== null)
        fail('forbidden');
      return db.begin(async (tx) => {
        const [base] = await tx<
          { task: RuntimeTaskRef }[]
        >`select task from allrice_runtime_roots where root_run_id=${task.rootRunId} for update`;
        if (
          !base ||
          runtimeLedgerInputDigest(base.task) !== runtimeLedgerInputDigest(task)
        )
          fail('forbidden');
        const [existing] =
          await tx`select configuration,worker_job_id,worker_id,generation from allrice_assistant_roots where root_run_id=${task.rootRunId}`;
        if (
          existing &&
          (runtimeLedgerInputDigest(existing.configuration) !==
            runtimeLedgerInputDigest(configuration) ||
            existing.worker_job_id !== input.worker.jobId ||
            existing.worker_id !== input.worker.workerId ||
            Number(existing.generation) !== input.worker.generation)
        )
          fail('conflict');
        if (!existing)
          await tx`insert into allrice_assistant_roots(root_run_id,configuration,worker_job_id,worker_id,generation)
          values(${task.rootRunId},${json(tx, configuration)},${input.worker.jobId},${input.worker.workerId},${input.worker.generation})`;
        const root = await lock(tx, task.scope, task.rootRunId);
        await assertLease(tx, root, input.worker, false);
        await authorize({
          transaction: tx,
          task,
          tools: allowedTools,
          phase: 'configure',
        });
        const creationDigest = runtimeLedgerInputDigest({
          task,
          nativeSessionId: input.nativeSessionId,
          allowedTools,
        });
        const [old] = await tx<
          Instance[]
        >`select * from allrice_assistant_instances where run_id=${task.runId}`;
        if (old) {
          if (old.creation_digest !== creationDigest) fail('conflict');
          return view(old);
        }
        const [row] = await tx<
          Instance[]
        >`insert into allrice_assistant_instances(run_id,root_run_id,parent_run_id,native_session_id,delegation_id,creation_digest,label,depth,allowed_tools,artifact_namespace,status)
          values(${task.runId},${task.rootRunId},null,${input.nativeSessionId},${task.runId},${creationDigest},'Rice',0,${json(tx, allowedTools)},${`assistant/${task.rootRunId}/${task.runId}/`},'running') returning *`;
        return view(row!);
      });
    },
    async provision(input: {
      scope: RuntimeScope;
      rootRunId: string;
      parentRunId: string;
      delegationId: string;
      label: string;
      text: string;
      tools: string[];
      worker: AssistantWorkerLease;
    }) {
      const label = z.string().trim().min(1).max(120).parse(input.label),
        text = z.string().trim().min(1).max(16000).parse(input.text);
      const tools = [...new Set(toolsSchema.parse(input.tools))].sort();
      uuid.parse(input.delegationId);
      return db.begin(async (tx) => {
        const root = await lock(tx, input.scope, input.rootRunId);
        await assertLease(tx, root, input.worker);
        const parent = await active(tx, root, input.parentRunId);
        const creationDigest = runtimeLedgerInputDigest({
          parent: parent.run_id,
          label,
          text,
          tools,
        });
        const [old] = await tx<
          Instance[]
        >`select * from allrice_assistant_instances where delegation_id=${input.delegationId}`;
        if (old) {
          if (
            old.root_run_id !== root.root_run_id ||
            old.creation_digest !== creationDigest
          )
            fail('conflict');
          return { instance: view(old), created: false };
        }
        if (tools.some((t) => !parent.allowed_tools.includes(t)))
          fail('forbidden');
        await authorize({
          transaction: tx,
          task: taskFor(root, parent),
          tools,
          phase: 'delegate',
        });
        const counts = await tx<
          { count: string; active: string }[]
        >`select count(*) as count,count(*) filter(where status in ('provisioning','running','waiting','cancel_requested','unknown')) as active from allrice_assistant_instances where root_run_id=${root.root_run_id} and parent_run_id is not null`;
        if (
          parent.depth + 1 > root.configuration.maxDepth ||
          Number(counts[0]!.count) >= root.configuration.maxChildren ||
          Number(counts[0]!.active) >= root.configuration.maxConcurrent
        )
          fail('limit_exceeded');
        const [budget] =
          await tx`select 1 from allrice_runtime_budgets where root_run_id=${root.root_run_id} and metric='model_calls' and capacity>spent+reserved`;
        if (!budget) fail('budget_exhausted');
        const runId = randomUUID(),
          nativeId = randomUUID();
        await tx`insert into allrice_runs(id,organization_id,workspace_id,project_id,owner_id,state,visibility,policy_snapshot_id,execution_spec,input)
          select ${runId},organization_id,workspace_id,project_id,owner_id,'running',visibility,policy_snapshot_id,execution_spec,
            ${json(tx, { assistant: { rootRunId: root.root_run_id, parentRunId: parent.run_id, delegationId: input.delegationId } })} from allrice_runs where id=${root.root_run_id}`;
        const task = { ...root.task, runId, parentRunId: parent.run_id };
        await tx`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task)
          values(${runId},${root.root_run_id},${parent.run_id},${input.scope.organizationId},${input.scope.workspaceId},${json(tx, task)})`;
        const [row] = await tx<
          Instance[]
        >`insert into allrice_assistant_instances(run_id,root_run_id,parent_run_id,native_session_id,delegation_id,creation_digest,label,depth,allowed_tools,artifact_namespace,status)
          values(${runId},${root.root_run_id},${parent.run_id},${nativeId},${input.delegationId},${creationDigest},${label},${parent.depth + 1},${json(tx, tools)},${`assistant/${root.root_run_id}/${runId}/`},'provisioning') returning *`;
        await queue(tx, root, parent, row!, input.delegationId, text);
        // Reserve launch before materializing a native child. The first model
        // dispatch atomically transfers this hold into its exact call vector.
        const [hold] =
          await tx`update allrice_runtime_budgets set reserved=reserved+1 where root_run_id=${root.root_run_id} and metric='model_calls' and spent+reserved+1<=capacity returning metric`;
        if (!hold) fail('budget_exhausted');
        await tx`insert into allrice_assistant_usage(call_id,run_id,root_run_id,metric,amount) values(${input.delegationId},${runId},${root.root_run_id},'model_calls',1)`;
        await assertLease(tx, root, input.worker);
        return { instance: view(row!), created: true };
      });
    },
    async getTree(context: RequestContext, input: { runId: string }) {
      return db.begin(async (tx) => {
        const root = await owner(tx, context, input.runId);
        const instances = await tx<
          Instance[]
        >`select * from allrice_assistant_instances where root_run_id=${root.root_run_id} order by created_at,run_id`;
        const messages = await tx<
          Message[]
        >`select * from allrice_assistant_messages where root_run_id=${root.root_run_id} order by created_at desc,input_id desc limit 64`;
        const results = await tx<
          {
            delivery_id: string;
            run_id: string;
            payload: AssistantResult;
            parent_message_id: string | null;
            parent_adopted_seq: string | null;
          }[]
        >`select * from allrice_assistant_results where root_run_id=${root.root_run_id} order by created_at desc limit 64`;
        const budgets = await tx<
          {
            metric: string;
            unit: string;
            currency: string | null;
            capacity: string;
            reserved: string;
            spent: string;
          }[]
        >`select metric,unit,currency,capacity,reserved,spent from allrice_runtime_budgets where root_run_id=${root.root_run_id} order by metric`;
        return {
          rootRunId: root.root_run_id,
          configuration: root.configuration,
          cancelRequested: !!root.cancel_request_id,
          instances: instances.map(view),
          messages: messages.map((m) => ({
            ...messageView(m),
            text: m.content.slice(0, 2000),
          })),
          results: results.map((r) => ({
            ...r.payload,
            runId: r.run_id,
            parentMessageId: r.parent_message_id,
            parentAdoptedSeq:
              r.parent_adopted_seq === null
                ? null
                : Number(r.parent_adopted_seq),
          })),
          budgets: budgets.map((b) => ({
            ...b,
            capacity: Number(b.capacity),
            reserved: Number(b.reserved),
            spent: Number(b.spent),
            usageComplete: Number(b.reserved) === 0,
          })),
        };
      });
    },
    async requestMessage(
      context: RequestContext,
      raw: z.infer<typeof AssistantMessageRequestSchema>,
    ) {
      enabled();
      const input = AssistantMessageRequestSchema.parse(raw);
      return db.begin(async (tx) => {
        const root = await owner(tx, context, input.runId);
        if (root.cancel_request_id || root.revoked_at) fail('canceled');
        if (!root.configuration.allowAssistants) fail('disabled');
        const child = await active(tx, root, input.childRunId);
        if (!child.parent_run_id) fail('forbidden');
        const parent = await active(tx, root, child.parent_run_id);
        await authorize({
          transaction: tx,
          task: taskFor(root, child),
          tools: [],
          phase: 'message',
        });
        return queue(tx, root, parent, child, input.inputId, input.text);
      });
    },
    async claimMessage(input: {
      scope: RuntimeScope;
      rootRunId: string;
      inputId: string;
      worker: AssistantWorkerLease;
    }) {
      return db.begin(async (tx) => {
        const root = await lock(tx, input.scope, input.rootRunId);
        await assertLease(tx, root, input.worker);
        const [m] = await tx<
          Message[]
        >`select * from allrice_assistant_messages where input_id=${input.inputId} and root_run_id=${root.root_run_id} for update`;
        if (!m) fail('not_found');
        const child = await active(tx, root, m.recipient_run_id);
        await authorize({
          transaction: tx,
          task: taskFor(root, child),
          tools: [],
          phase: 'message',
        });
        if (m.status !== 'pending')
          return {
            message: messageView(m),
            dispatch: false,
            instance: view(child),
          };
        await tx`update allrice_assistant_messages set status='dispatching' where input_id=${m.input_id}`;
        return {
          message: messageView({ ...m, status: 'dispatching' }),
          dispatch: true,
          instance: view(child),
        };
      });
    },
    async checkpointMessage(input: {
      scope: RuntimeScope;
      rootRunId: string;
      inputId: string;
      worker: AssistantWorkerLease;
      nativeMessageId: string;
      durableSeq?: number;
      adoptedSeq?: number;
    }) {
      z.string().min(1).max(200).parse(input.nativeMessageId);
      if (input.durableSeq !== undefined)
        z.number().int().nonnegative().parse(input.durableSeq);
      if (input.adoptedSeq !== undefined)
        z.number().int().nonnegative().parse(input.adoptedSeq);
      return db.begin(async (tx) => {
        const root = await lock(tx, input.scope, input.rootRunId);
        await assertLease(tx, root, input.worker, false);
        const [m] = await tx<
          Message[]
        >`select * from allrice_assistant_messages where input_id=${input.inputId} and root_run_id=${root.root_run_id} for update`;
        if (!m) fail('not_found');
        if (
          m.native_message_id &&
          m.native_message_id !== input.nativeMessageId
        )
          fail('conflict');
        if (
          (m.durable_seq !== null &&
            input.durableSeq !== undefined &&
            Number(m.durable_seq) !== input.durableSeq) ||
          (m.adopted_seq !== null &&
            input.adoptedSeq !== undefined &&
            Number(m.adopted_seq) !== input.adoptedSeq)
        )
          fail('conflict');
        if (m.status === 'pending') fail('conflict');
        if (m.status === 'canceled') return messageView(m);
        const durable =
            m.durable_seq === null ? input.durableSeq : Number(m.durable_seq),
          adopted =
            m.adopted_seq === null ? input.adoptedSeq : Number(m.adopted_seq);
        if (adopted !== undefined && durable === undefined) fail('conflict');
        const status =
          adopted !== undefined
            ? 'adopted'
            : durable !== undefined
              ? 'durable'
              : 'accepted';
        const [updated] = await tx<
          Message[]
        >`update allrice_assistant_messages set native_message_id=${input.nativeMessageId},durable_seq=${durable ?? null},adopted_seq=${adopted ?? null},status=${status} where input_id=${m.input_id} returning *`;
        await tx`update allrice_assistant_instances set status='running',updated_at=clock_timestamp() where run_id=${m.recipient_run_id} and status='provisioning' and cancel_requested_at is null`;
        return messageView(updated!);
      });
    },
    async reserveUsage(input: {
      scope: RuntimeScope;
      rootRunId: string;
      runId: string;
      worker: AssistantWorkerLease;
      callId: string;
      amounts: Record<string, number>;
      kind: 'model' | 'tool';
      tool?: string;
      /** Trusted proposal admission only. Does not authorize the action. */
      proposal?: boolean;
    }) {
      uuid.parse(input.callId);
      const amounts = amountsSchema.parse(input.amounts);
      if (amounts[input.kind === 'model' ? 'model_calls' : 'tool_calls'] !== 1)
        fail('forbidden');
      return db.begin(async (tx) => {
        const root = await lock(tx, input.scope, input.rootRunId);
        await assertLease(tx, root, input.worker);
        const row = await active(tx, root, input.runId);
        if (
          input.kind === 'tool' &&
          (!input.tool || !row.allowed_tools.includes(input.tool))
        )
          fail('forbidden');
        await authorize({
          transaction: tx,
          task: taskFor(root, row),
          tools: input.tool ? [input.tool] : [],
          phase:
            input.kind === 'tool' && input.proposal ? 'proposal' : input.kind,
        });
        await assertLease(tx, root, input.worker);
        const dimensions = await tx<
          { metric: string }[]
        >`select metric from allrice_runtime_budgets where root_run_id=${root.root_run_id}`;
        if (
          dimensions.some(
            ({ metric }) =>
              amounts[metric as keyof typeof amounts] === undefined,
          )
        )
          fail('budget_exhausted');
        if (
          input.kind === 'model' &&
          ((amounts.input_tokens ?? 0) <= 0 ||
            (amounts.output_tokens ?? 0) <= 0)
        )
          fail('budget_exhausted');
        const old = await tx<
          { run_id: string; metric: string; amount: string }[]
        >`select * from allrice_assistant_usage where call_id=${input.callId} order by metric`;
        if (old.length) {
          if (
            old.some((v) => v.run_id !== input.runId) ||
            runtimeLedgerInputDigest(
              Object.fromEntries(old.map((v) => [v.metric, Number(v.amount)])),
            ) !== runtimeLedgerInputDigest(amounts)
          )
            fail('conflict');
          return { reserved: false };
        }
        if (input.kind === 'model' && row.parent_run_id) {
          const [launch] =
            await tx`update allrice_assistant_usage set settled_amount=0 where call_id=${row.delegation_id} and run_id=${row.run_id} and metric='model_calls' and settled_amount is null returning amount`;
          if (launch)
            await tx`update allrice_runtime_budgets set reserved=reserved-${Number(launch.amount)} where root_run_id=${root.root_run_id} and metric='model_calls'`;
        }
        for (const [metric, amount] of Object.entries(amounts)) {
          const [b] =
            await tx`update allrice_runtime_budgets set reserved=reserved+${amount} where root_run_id=${root.root_run_id} and metric=${metric} and reserved+spent+${amount}<=capacity returning metric`;
          if (!b) fail('budget_exhausted');
          await tx`insert into allrice_assistant_usage(call_id,run_id,root_run_id,metric,amount) values(${input.callId},${row.run_id},${root.root_run_id},${metric},${amount})`;
        }
        await assertLease(tx, root, input.worker);
        return { reserved: true };
      });
    },
    async settleUsage(input: {
      scope: RuntimeScope;
      rootRunId: string;
      worker: AssistantWorkerLease;
      callId: string;
      runId?: string;
      amounts: Record<string, number>;
    }) {
      const amounts = amountsSchema.parse(input.amounts);
      return db.begin(async (tx) => {
        const root = await lock(tx, input.scope, input.rootRunId);
        await assertLease(tx, root, input.worker, false);
        const rows = await tx<
          {
            run_id: string;
            metric: string;
            amount: string;
            settled_amount: string | null;
          }[]
        >`select * from allrice_assistant_usage where root_run_id=${root.root_run_id} and call_id=${input.callId} for update`;
        if (
          !rows.length ||
          (input.runId !== undefined &&
            rows.some((r) => r.run_id !== input.runId)) ||
          Object.keys(amounts).some(
            (metric) => !rows.some((r) => r.metric === metric),
          )
        )
          fail('conflict');
        for (const row of rows) {
          const amount = amounts[row.metric as keyof typeof amounts];
          if (amount === undefined) continue; // Unknown usage keeps its reservation.
          if (row.settled_amount !== null) {
            if (Number(row.settled_amount) !== amount) fail('conflict');
            continue;
          }
          await tx`update allrice_assistant_usage set settled_amount=${amount} where call_id=${input.callId} and metric=${row.metric}`;
          const [b] = await tx<
            { spent: string; reserved: string; capacity: string }[]
          >`update allrice_runtime_budgets set reserved=reserved-${Number(row.amount)},spent=spent+${amount} where root_run_id=${root.root_run_id} and metric=${row.metric} returning spent,reserved,capacity`;
          if (Number(b!.spent) + Number(b!.reserved) > Number(b!.capacity))
            await cancelAssistantRootTransaction(
              tx,
              root.root_run_id,
              randomUUID(),
              'budget_exhausted',
            );
        }
      });
    },
    async recordResult(input: {
      scope: RuntimeScope;
      rootRunId: string;
      runId: string;
      worker: AssistantWorkerLease;
      result: AssistantResult;
    }) {
      const result = AssistantResultSchema.parse(input.result),
        digest = runtimeLedgerInputDigest(result);
      return db.begin(async (tx) => {
        const root = await lock(tx, input.scope, input.rootRunId);
        await assertLease(tx, root, input.worker, false);
        const row = await instance(tx, root, input.runId);
        if (!row.parent_run_id) fail('forbidden');
        const [old] =
          await tx`select payload_digest,run_id from allrice_assistant_results where delivery_id=${result.deliveryId}`;
        if (old) {
          if (old.payload_digest !== digest || old.run_id !== row.run_id)
            fail('conflict');
          return { wakeParent: false, duplicate: true, status: result.status };
        }
        const [prior] =
          await tx`select 1 from allrice_assistant_results where run_id=${row.run_id} limit 1`;
        if (prior || terminal.has(row.status)) fail('conflict');
        // An explicit completion must cite platform-registered immutable evidence;
        // idle or arbitrary final text is never a successful delivery.
        if (
          result.status === 'completed' &&
          (!result.evidence.length || result.incomplete.length)
        )
          fail('conflict');
        for (const ref of result.evidence) {
          const [artifact] =
            await tx`select 1 from allrice_assistant_artifacts where run_id=${row.run_id} and artifact_id=${ref.id} and digest=${ref.digest}`;
          if (!artifact) fail('forbidden');
        }
        const [pending] =
          await tx`select 1 from allrice_runtime_operations where (run_id=${row.run_id} or snapshot->>'agentInstanceId'=${row.run_id}) and snapshot->>'status' not in ('succeeded','failed','partial','canceled') limit 1`;
        const status = pending ? 'unknown' : result.status;
        const effective = pending
          ? {
              ...result,
              status: 'unknown' as const,
              incomplete: [
                ...result.incomplete,
                'Execution evidence is still unresolved.',
              ].slice(0, 32),
              usageComplete: false,
            }
          : result;
        await tx`insert into allrice_assistant_results(delivery_id,run_id,root_run_id,payload,payload_digest) values(${result.deliveryId},${row.run_id},${root.root_run_id},${json(tx, effective)},${digest})`;
        if (!row.cancel_requested_at && !terminal.has(row.status))
          await tx`update allrice_assistant_instances set status=${status},updated_at=clock_timestamp() where run_id=${row.run_id}`;
        if (!pending && !row.cancel_requested_at && result.status !== 'unknown')
          await tx`update allrice_runs set state=${result.status === 'completed' ? 'succeeded' : result.status === 'canceled' ? 'canceled' : 'failed'},updated_at=clock_timestamp() where id=${row.run_id}`;
        const parent = await instance(tx, root, row.parent_run_id);
        return {
          wakeParent:
            !root.cancel_request_id &&
            !root.revoked_at &&
            !row.cancel_requested_at &&
            !pending &&
            status !== 'unknown' &&
            !parent.cancel_requested_at &&
            !terminal.has(parent.status) &&
            parent.status !== 'unknown',
          duplicate: false,
          status,
        };
      });
    },
    async adoptResult(input: {
      scope: RuntimeScope;
      rootRunId: string;
      parentRunId: string;
      worker: AssistantWorkerLease;
      deliveryId: string;
      nativeMessageId: string;
      adoptedSeq: number;
    }) {
      z.number().int().nonnegative().parse(input.adoptedSeq);
      z.string().min(1).max(200).parse(input.nativeMessageId);
      return db.begin(async (tx) => {
        const root = await lock(tx, input.scope, input.rootRunId);
        await assertLease(tx, root, input.worker);
        await active(tx, root, input.parentRunId);
        const [result] = await tx<
          {
            parent_message_id: string | null;
            parent_adopted_seq: string | null;
          }[]
        >`select r.* from allrice_assistant_results r join allrice_assistant_instances i on i.run_id=r.run_id where r.delivery_id=${input.deliveryId} and r.root_run_id=${root.root_run_id} and i.parent_run_id=${input.parentRunId} and i.cancel_requested_at is null and i.status<>'unknown' for update of r`;
        if (!result) fail('not_found');
        if (
          result.parent_message_id &&
          (result.parent_message_id !== input.nativeMessageId ||
            Number(result.parent_adopted_seq) !== input.adoptedSeq)
        )
          fail('conflict');
        await tx`update allrice_assistant_results set parent_message_id=${input.nativeMessageId},parent_adopted_seq=${input.adoptedSeq} where delivery_id=${input.deliveryId}`;
      });
    },
    async resultDelivery(input: {
      scope: RuntimeScope;
      rootRunId: string;
      runId: string;
      worker: AssistantWorkerLease;
    }) {
      return db.begin(async (tx) => {
        const root = await lock(tx, input.scope, input.rootRunId);
        await assertLease(tx, root, input.worker, false);
        const child = await instance(tx, root, input.runId);
        if (!child.parent_run_id) fail('forbidden');
        const parent = await instance(tx, root, child.parent_run_id);
        const [delivery] = await tx<
          { payload: AssistantResult }[]
        >`select payload from allrice_assistant_results where run_id=${child.run_id} order by created_at desc limit 1`;
        return {
          result: delivery?.payload ?? null,
          wakeParent:
            !!delivery &&
            !root.cancel_request_id &&
            !child.cancel_requested_at &&
            !parent.cancel_requested_at &&
            !root.revoked_at &&
            child.status !== 'unknown' &&
            !terminal.has(parent.status) &&
            parent.status !== 'unknown',
        };
      });
    },
    async registerArtifact(input: {
      scope: RuntimeScope;
      rootRunId: string;
      runId: string;
      worker: AssistantWorkerLease;
      relativePath: string;
      artifactId: string;
      digest: string;
    }) {
      const path = z.string().min(1).max(240).parse(input.relativePath);
      if (
        path.startsWith('/') ||
        path.includes('\\') ||
        path.split('/').some((p) => !p || p === '.' || p === '..')
      )
        fail('forbidden');
      uuid.parse(input.artifactId);
      z.string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .parse(input.digest);
      return db.begin(async (tx) => {
        const root = await lock(tx, input.scope, input.rootRunId);
        await assertLease(tx, root, input.worker);
        const row = await active(tx, root, input.runId);
        const [artifact] =
          await tx`select a.version_id from allrice_workbench_artifacts a join allrice_deliverable_versions v on v.id=a.version_id join allrice_storage_objects o on o.id=v.object_id
          where a.version_id=${input.artifactId} and a.run_id=${row.run_id} and a.organization_id=${root.task.scope.organizationId} and a.workspace_id=${root.task.scope.workspaceId}
          and v.session_id=${root.task.chatSessionId} and o.checksum=${input.digest} and o.state='ready' and o.immutable=true and o.organization_id=a.organization_id and o.workspace_id=a.workspace_id for share of a,v,o`;
        if (!artifact) fail('forbidden');
        const [old] =
          await tx`select * from allrice_assistant_artifacts where run_id=${row.run_id} and relative_path=${path}`;
        if (old) {
          if (
            old.artifact_id !== input.artifactId ||
            old.digest !== input.digest
          )
            fail('conflict');
          return { path: `${row.artifact_namespace}${path}` };
        }
        await tx`insert into allrice_assistant_artifacts(run_id,relative_path,artifact_id,digest) values(${row.run_id},${path},${input.artifactId},${input.digest})`;
        return { path: `${row.artifact_namespace}${path}` };
      });
    },
    async cancelRoot(
      context: RequestContext,
      input: { runId: string; requestId: string },
    ) {
      uuid.parse(input.requestId);
      return db.begin(async (tx) => {
        const root = await owner(tx, context, input.runId);
        await cancelAssistantRootTransaction(
          tx,
          root.root_run_id,
          input.requestId,
        );
        return { cancelRequested: true, stopped: false };
      });
    },
    async cancelChild(
      context: RequestContext,
      input: { runId: string; childRunId: string; requestId: string },
    ) {
      uuid.parse(input.requestId);
      return db.begin(async (tx) => {
        const root = await owner(tx, context, input.runId),
          child = await instance(tx, root, input.childRunId);
        if (!child.parent_run_id) fail('forbidden');
        await tx`with recursive subtree as (select run_id from allrice_assistant_instances where run_id=${child.run_id} union all select c.run_id from allrice_assistant_instances c join subtree p on c.parent_run_id=p.run_id)
          update allrice_assistant_instances set cancel_request_id=coalesce(cancel_request_id,${input.requestId}),cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),status=case when status in ('completed','partial','failed','canceled') then status else 'cancel_requested' end where run_id in(select run_id from subtree)`;
        await tx`update allrice_assistant_messages set status='canceled' where status='pending' and recipient_run_id in(select run_id from allrice_assistant_instances where root_run_id=${root.root_run_id} and cancel_requested_at is not null)`;
        const canceled = await tx<
          { run_id: string }[]
        >`select run_id from allrice_assistant_instances where root_run_id=${root.root_run_id} and cancel_requested_at is not null`;
        await cancelRuntimeAgentOperationsTransaction(
          tx,
          root.root_run_id,
          input.requestId,
          canceled.map((row) => row.run_id),
        );
        return { cancelRequested: true, stopped: false };
      });
    },
    async confirmStopped(input: {
      scope: RuntimeScope;
      rootRunId: string;
      runId: string;
      worker: AssistantWorkerLease;
    }) {
      return db.begin(async (tx) => {
        const root = await lock(tx, input.scope, input.rootRunId);
        await assertLease(tx, root, input.worker, false);
        const row = await instance(tx, root, input.runId);
        if (!row.cancel_requested_at) fail('conflict');
        const [operation] =
          await tx`select 1 from allrice_runtime_operations where (run_id=${row.run_id} or snapshot->>'agentInstanceId'=${row.run_id}) and snapshot->>'status' not in ('succeeded','failed','partial','canceled') limit 1`;
        if (operation) fail('unknown');
        await tx`update allrice_assistant_instances set stopped_at=clock_timestamp(),status=case when status in ('completed','partial','failed') then status else 'canceled' end where run_id=${row.run_id}`;
        if (row.run_id !== row.root_run_id)
          await tx`update allrice_runs set state='canceled',updated_at=clock_timestamp() where id=${row.run_id} and state in ('running','queued','waiting_approval')`;
        return { stopped: true };
      });
    },
    /** Lease loss never silently authorizes takeover. Only tombstones execution
     * rights and marks uncertain dispatches; a new worker cannot replay them. */
    async quarantineExpired(input: { scope: RuntimeScope; rootRunId: string }) {
      return db.begin(async (tx) => {
        const root = await lock(tx, input.scope, input.rootRunId);
        const [live] =
          await tx`select 1 from allrice_jobs where id=${root.worker_job_id} and worker_id=${root.worker_id} and status='running' and lease_expires_at>clock_timestamp()`;
        if (live) fail('conflict');
        if (!root.revoked_at)
          await tx`update allrice_assistant_roots set revoked_at=clock_timestamp(),fence=fence+1 where root_run_id=${root.root_run_id}`;
        await tx`update allrice_assistant_instances set status='unknown' where root_run_id=${root.root_run_id} and status in ('provisioning','running','waiting','cancel_requested')`;
        await tx`update allrice_assistant_messages set status='unknown' where root_run_id=${root.root_run_id} and status in ('dispatching','accepted')`;
        return { replay: false, requiresReconciliation: true };
      });
    },
  };
  return api;
}
export type AssistantRuntime = ReturnType<typeof createAssistantRuntime>;
export type AssistantTreeView = Awaited<
  ReturnType<AssistantRuntime['getTree']>
>;
