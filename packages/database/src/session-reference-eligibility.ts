import {
  SessionReferenceEligibilitySchema,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { DataAccessError } from './data.ts';

/** A read-only reference-dependency fact, never permission to bypass send admission. */
export async function readSessionReferenceEligibility(
  context: RequestContext,
  workspaceIdInput: string,
  sessionIdInput: string,
) {
  const workspaceId = UuidSchema.parse(workspaceIdInput);
  const sessionId = UuidSchema.parse(sessionIdInput);
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  if (context.workspaceId && context.workspaceId !== workspaceId)
    throw new DataAccessError('authorization_denied');
  const scoped = { ...context, workspaceId };
  const sql = getDatabase();
  if (!(await readContentPrincipal(scoped, sql)))
    throw new DataAccessError('authorization_denied');
  const [session] = await sql`select id from allrice_chat_sessions
    where id=${sessionId} and organization_id=${context.organizationId}
      and workspace_id=${workspaceId} and owner_id=${context.actor.id}`;
  if (!session) throw new DataAccessError('not_found');
  return SessionReferenceEligibilitySchema.parse({
    viewerId: context.actor.id,
    sessionId,
    // Historical reference reads never revoke permission to continue chatting.
    referenceEligibility: { canContinue: true, reason: null },
  });
}
