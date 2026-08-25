import { createHash } from 'node:crypto';

import {
  ContextCheckpointSchema,
  UuidSchema,
  type ContextCheckpoint,
  type HarnessKind,
} from '@allrice/contracts';
import { z } from 'zod';

import { getDatabase } from './index.ts';

const ChecksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

interface CheckpointRow {
  id: string;
  session_id: string;
  harness: HarnessKind;
  thread_id: string | null;
  thread_generation: number;
  covered_through_message_id: string | null;
  summary_version: 'extractive-v1';
  summary: string;
  checksum: string;
  config_checksum: string;
  estimated_tokens: number;
  message_count: number;
  created_at: Date;
}

export interface CheckpointMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
}

function canonicalCheckpoint(input: {
  sessionId: string;
  harness: HarnessKind;
  threadId: string | null;
  generation: number;
  coveredThroughMessageId: string | null;
  summaryVersion: 'extractive-v1';
  summary: string;
  configChecksum: string;
  estimatedTokens: number;
  messageCount: number;
}) {
  return JSON.stringify(input);
}

export function contextCheckpointChecksum(
  input: Parameters<typeof canonicalCheckpoint>[0],
) {
  return `sha256:${createHash('sha256')
    .update(canonicalCheckpoint(input))
    .digest('hex')}`;
}

function mappedCheckpoint(row: CheckpointRow): ContextCheckpoint | null {
  const values = {
    sessionId: row.session_id,
    harness: row.harness,
    threadId: row.thread_id,
    generation: row.thread_generation,
    coveredThroughMessageId: row.covered_through_message_id,
    summaryVersion: row.summary_version,
    summary: row.summary,
    configChecksum: row.config_checksum,
    estimatedTokens: row.estimated_tokens,
    messageCount: row.message_count,
  } as const;
  if (contextCheckpointChecksum(values) !== row.checksum) return null;
  return ContextCheckpointSchema.parse({
    schemaVersion: 1,
    checkpointId: row.id,
    ...values,
    checksum: row.checksum,
    createdAt: row.created_at.toISOString(),
  });
}

export function estimateConversationTokens(text: string) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

export function shouldCreateContextCheckpoint(input: {
  estimatedTokens: number;
  thresholdTokens: number;
  coveredThroughMessageId: string | null;
  latestCoveredThroughMessageId?: string | null;
}) {
  return (
    input.estimatedTokens >= input.thresholdTokens &&
    Boolean(input.coveredThroughMessageId) &&
    input.coveredThroughMessageId !== input.latestCoveredThroughMessageId
  );
}

export function buildExtractiveContextSummary(input: {
  previousSummary?: string;
  messages: CheckpointMessage[];
  maximumCharacters?: number;
}) {
  const limit = input.maximumCharacters ?? 12_000;
  const importantPattern =
    /目标|决定|决策|文件|结果|待办|偏好|风险|约束|goal|decision|file|result|todo|preference|risk|constraint/i;
  const important = input.messages.filter((message) =>
    importantPattern.test(message.text),
  );
  const recent = input.messages.slice(-12);
  const selected = [
    ...new Map(
      [...important, ...recent].map((message) => [message.id, message]),
    ).values(),
  ];
  const sections = [
    input.previousSummary?.trim()
      ? `Previous checkpoint:\n${input.previousSummary.trim()}`
      : '',
    selected.length
      ? `Covered conversation (${input.messages.length} messages):\n${selected
          .map((message) => `[${message.role} ${message.id}] ${message.text}`)
          .join('\n')}`
      : '',
  ].filter(Boolean);
  const summary = sections.join('\n\n');
  if (summary.length <= limit) return summary;
  return `${summary.slice(0, Math.max(0, limit - 28))}\n[checkpoint truncated safely]`;
}

export async function getLatestContextCheckpoint(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  ownerId: string;
  configChecksum: string;
}) {
  const sql = getDatabase();
  const rows = await sql<CheckpointRow[]>`
    select * from allrice_context_checkpoints
    where organization_id = ${UuidSchema.parse(input.organizationId)}
      and workspace_id = ${UuidSchema.parse(input.workspaceId)}
      and session_id = ${UuidSchema.parse(input.sessionId)}
      and owner_id = ${UuidSchema.parse(input.ownerId)}
      and config_checksum = ${ChecksumSchema.parse(input.configChecksum)}
    order by created_at desc, id desc
    limit 1
  `;
  return rows[0] ? mappedCheckpoint(rows[0]) : null;
}

export async function listContextCheckpointEvidence(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  ownerId: string;
}) {
  const sql = getDatabase();
  const values = {
    organizationId: UuidSchema.parse(input.organizationId),
    workspaceId: UuidSchema.parse(input.workspaceId),
    sessionId: UuidSchema.parse(input.sessionId),
    ownerId: UuidSchema.parse(input.ownerId),
  };
  const tools = await sql<{ id: string; label: string; summary: string }[]>`
    select e.id, coalesce(e.payload ->> 'label', e.payload ->> 'name', 'Tool') as label,
      coalesce(e.payload ->> 'summary', 'completed') as summary
    from allrice_run_events e
    join allrice_employee_runs er on er.run_id = e.run_id
    where er.organization_id = ${values.organizationId}
      and er.workspace_id = ${values.workspaceId}
      and er.session_id = ${values.sessionId}
      and er.owner_id = ${values.ownerId}
      and e.event_type = 'tool.completed'
    order by e.occurred_at desc
    limit 40
  `;
  const files = await sql<
    { id: string; file_name: string; media_type: string }[]
  >`
    select o.id, a.file_name, o.media_type
    from allrice_message_attachments a
    join allrice_messages m
      on m.organization_id = a.organization_id
     and m.workspace_id = a.workspace_id
     and m.id = a.message_id
    join allrice_storage_objects o on o.id = a.object_id
    where m.organization_id = ${values.organizationId}
      and m.workspace_id = ${values.workspaceId}
      and m.session_id = ${values.sessionId}
      and m.owner_id = ${values.ownerId}
    order by m.created_at desc
    limit 40
  `;
  return [
    ...files.map((file) => ({
      id: file.id,
      role: 'tool' as const,
      text: `File reference: ${file.file_name} (${file.media_type})`,
    })),
    ...tools.reverse().map((tool) => ({
      id: tool.id,
      role: 'tool' as const,
      text: `Tool result: ${tool.label}: ${tool.summary}`,
    })),
  ];
}

export async function saveContextCheckpoint(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  ownerId: string;
  runId: string;
  workerId: string;
  harness: HarnessKind;
  threadId: string | null;
  generation: number;
  coveredThroughMessageId: string;
  summary: string;
  configChecksum: string;
  estimatedTokens: number;
  messageCount: number;
}) {
  const values = {
    sessionId: UuidSchema.parse(input.sessionId),
    harness: input.harness,
    threadId: input.threadId,
    generation: input.generation,
    coveredThroughMessageId: UuidSchema.parse(input.coveredThroughMessageId),
    summaryVersion: 'extractive-v1' as const,
    summary: input.summary,
    configChecksum: ChecksumSchema.parse(input.configChecksum),
    estimatedTokens: input.estimatedTokens,
    messageCount: input.messageCount,
  };
  const checksum = contextCheckpointChecksum(values);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const runtimes = await transaction<
      { state: string; active_turn_id: string | null }[]
    >`
      select state, active_turn_id from allrice_conversation_runtimes
      where organization_id = ${UuidSchema.parse(input.organizationId)}
        and workspace_id = ${UuidSchema.parse(input.workspaceId)}
        and session_id = ${values.sessionId}
        and owner_id = ${UuidSchema.parse(input.ownerId)}
        and active_run_id = ${UuidSchema.parse(input.runId)}
        and worker_id = ${UuidSchema.parse(input.workerId)}
      for update
    `;
    if (runtimes[0]?.state !== 'running' || runtimes[0].active_turn_id) {
      throw new Error('context_checkpoint_unsafe_boundary');
    }
    const rows = await transaction<CheckpointRow[]>`
      insert into allrice_context_checkpoints (
        organization_id, workspace_id, session_id, owner_id, harness,
        thread_id, thread_generation, covered_through_message_id,
        summary_version, summary, checksum, config_checksum,
        estimated_tokens, message_count
      ) values (
        ${input.organizationId}, ${input.workspaceId}, ${values.sessionId},
        ${input.ownerId}, ${values.harness}, ${values.threadId},
        ${values.generation}, ${values.coveredThroughMessageId},
        ${values.summaryVersion}, ${values.summary}, ${checksum},
        ${values.configChecksum}, ${values.estimatedTokens},
        ${values.messageCount}
      ) on conflict (session_id, thread_generation, checksum)
        do update set summary = excluded.summary
      returning *
    `;
    await transaction`
      update allrice_conversation_runtimes
      set usage_baseline_input_tokens = null, last_input_tokens = null,
          last_cached_input_tokens = null, dynamic_context_tokens = 0,
          updated_at = now()
      where session_id = ${values.sessionId}
    `;
    return mappedCheckpoint(rows[0]!)!;
  });
}
