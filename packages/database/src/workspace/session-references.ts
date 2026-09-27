import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  SessionReferenceSnapshotsSchema,
  type RequestContext,
  type SessionReferenceSnapshot,
  type Visibility,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';

type Reader = ReturnType<typeof getDatabase> | TransactionSql;
type Principal = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
};
const visibilityRank = { private: 0, workspace: 1, organization: 2 };

export class SessionReferenceError extends Error {
  constructor(readonly code: 'unavailable' | 'empty' | 'visibility' | 'self') {
    super(
      {
        unavailable: '引用的会话不可用或已无权访问，请移除后重新选择。',
        empty: '这段会话还没有可引用的文字，请选择其他会话。',
        visibility: '引用资料的可见范围小于当前会话，请在私有会话中引用。',
        self: '请选择另一段会话作为参考。',
      }[code],
    );
  }
}

async function readableSource(db: Reader, scope: Principal, sessionId: string) {
  const [row] = await db<
    { id: string; title: string; visibility: Visibility }[]
  >`
    select s.id, s.title, s.visibility from allrice_chat_sessions s
    where s.id=${sessionId} and s.organization_id=${scope.organizationId}
      and s.workspace_id=${scope.workspaceId} and s.archived_at is null
      and (s.owner_id=${scope.ownerId} or s.visibility <> 'private')
      and exists (select 1 from allrice_users u where u.id=${scope.ownerId} and u.status='active')
      and exists (select 1 from allrice_workspaces w where w.id=s.workspace_id and w.archived_at is null)
      and exists (select 1 from allrice_organizations o where o.id=s.organization_id and o.archived_at is null)
      and exists (select 1 from allrice_memberships m where m.user_id=${scope.ownerId}
        and m.organization_id=s.organization_id and m.active
        and (m.workspace_id is null or m.workspace_id=s.workspace_id))
    for share of s`;
  if (!row) throw new SessionReferenceError('unavailable');
  return row;
}

/** Capture only tenant-visible conversation text, never tools or nested references. */
export async function captureSessionReferences(
  db: Reader,
  context: RequestContext,
  workspaceId: string,
  target: { id: string; visibility: Visibility },
  ids: string[],
): Promise<SessionReferenceSnapshot[]> {
  if (context.actor.type !== 'user')
    throw new SessionReferenceError('unavailable');
  const scope = {
    organizationId: context.organizationId,
    workspaceId,
    ownerId: context.actor.id,
  };
  if (!ids.length) return [];
  const [destination] = await db<
    { visibility: Visibility }[]
  >`select visibility from allrice_chat_sessions where id=${target.id} and organization_id=${scope.organizationId} and workspace_id=${workspaceId} and owner_id=${scope.ownerId} for share`;
  if (!destination) throw new SessionReferenceError('unavailable');
  const snapshots: SessionReferenceSnapshot[] = [];
  for (const id of ids) {
    if (id === target.id) throw new SessionReferenceError('self');
    const source = await readableSource(db, scope, id);
    if (
      visibilityRank[destination.visibility] > visibilityRank[source.visibility]
    )
      throw new SessionReferenceError('visibility');
    const rows = await db<
      {
        id: string;
        role: 'user' | 'assistant';
        text: string;
        created_at: Date;
        original_count: string;
        original_length: number;
      }[]
    >`
      select m.id, m.role, left(m.content->>'text', 24000) as text,
        length(m.content->>'text') as original_length, m.created_at,
        count(*) over () as original_count
      from allrice_messages m
      where m.session_id=${id} and m.organization_id=${scope.organizationId}
        and m.workspace_id=${workspaceId} and m.status='completed'
        and m.role in ('user','assistant') and length(trim(m.content->>'text')) > 0
        and not (m.content ? 'interaction')
        and (m.owner_id=${scope.ownerId} or m.visibility <> 'private')
        and not exists (select 1 from allrice_conversation_followups f
          where f.user_message_id=coalesce(m.reply_to_id,m.id) and f.state in ('queued','released','canceled'))
      order by m.created_at desc, m.id desc limit 200`;
    if (!rows.length) throw new SessionReferenceError('empty');
    let remaining = 65536;
    let truncated = false;
    const messages: SessionReferenceSnapshot['messages'] = [];
    for (const row of rows) {
      if (!remaining) break;
      let text = row.text;
      if (Buffer.byteLength(text) > remaining) {
        // Decode only complete code points at the bound, never introduce U+FFFD.
        const chars: string[] = [];
        let bytes = 0;
        for (const char of text) {
          if (bytes + Buffer.byteLength(char) > remaining) break;
          chars.push(char);
          bytes += Buffer.byteLength(char);
        }
        text = chars.join('');
        truncated = true;
      }
      if (!text) break;
      truncated ||= [...row.text].length < row.original_length;
      remaining -= Buffer.byteLength(text);
      messages.push({
        id: row.id,
        role: row.role,
        text,
        createdAt: row.created_at.toISOString(),
      });
    }
    messages.reverse();
    const originalMessages = Number(rows[0]!.original_count);
    const body = {
      sessionId: id,
      label: source.title.slice(0, 240) || '未命名会话',
      visibility: source.visibility,
      capturedAt: new Date().toISOString(),
      originalMessages,
      truncated: truncated || originalMessages > messages.length,
      messages,
    };
    snapshots.push({
      ...body,
      checksum: `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`,
    });
  }
  return SessionReferenceSnapshotsSchema.parse(snapshots);
}

/** Recheck admission when queued work starts; never recapture or silently omit a source. */
export async function assertSessionReferencesReadable(
  scope: Principal,
  snapshots: SessionReferenceSnapshot[],
) {
  if (!snapshots.length) return;
  await getDatabase().begin(async (db) => {
    for (const snapshot of snapshots) {
      const source = await readableSource(db, scope, snapshot.sessionId);
      if (
        visibilityRank[source.visibility] < visibilityRank[snapshot.visibility]
      )
        throw new SessionReferenceError('unavailable');
    }
  });
}

export async function assertReferenceVisibility(
  db: Reader,
  sessionId: string,
  visibility: Visibility,
) {
  if (visibility === 'private') return;
  const rows = await db<{ visibility: Visibility }[]>`
    select ref->>'visibility' as visibility from allrice_messages m,
      lateral jsonb_array_elements(m.session_references) ref where m.session_id=${sessionId}`;
  if (
    rows.some(
      (row) => visibilityRank[visibility] > visibilityRank[row.visibility],
    )
  )
    throw new SessionReferenceError('visibility');
}
