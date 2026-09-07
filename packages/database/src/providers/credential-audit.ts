import { UuidSchema, type RequestContext } from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { isPlatformAdmin } from './model-pool.ts';

/** Never accepts a credential, arbitrary metadata, or user-supplied reason. */
export async function recordGeminiCredentialChange(
  context: RequestContext,
  requestId: string,
  outcome: 'requested' | 'saved' | 'failed',
) {
  if (context.actor.type !== 'user' || !(await isPlatformAdmin(context)))
    throw new DataAccessError('authorization_denied');
  const id = UuidSchema.parse(requestId);
  const action = `provider.gemini_credential.${outcome}`;
  const sql = getDatabase();
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      decision, reason, request_id
    ) values (
      ${context.organizationId}, ${context.workspaceId}, ${context.actor.id},
      ${action}, 'provider_credential', 'recorded',
      'Platform Gemini API credential configuration; no execution or publication change', ${id}
    )
  `;
}
