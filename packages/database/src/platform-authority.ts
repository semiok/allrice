import type postgres from 'postgres';
import { UuidSchema, type RequestContext } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
type Principal = Pick<RequestContext, 'actor'>;

function platformAdminEmail(email: string) {
  return new Set(
    (process.env.ALLRICE_PLATFORM_ADMIN_EMAILS ?? 'semiokshen@gmail.com')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ).has(email.toLowerCase());
}

/** Platform administration is independent of a tenant's historical role. */
export async function isPlatformAdmin(context: Principal, sql?: Sql) {
  if (context.actor.type !== 'user') return false;
  const db = sql ?? getDatabase();
  const [user] = await db<{ email: string }[]>`
    select email from allrice_users where id=${context.actor.id} and status='active'
  `;
  return !!user && platformAdminEmail(user.email);
}

export async function requirePlatformAdmin(context: Principal, sql?: Sql) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  if (!(await isPlatformAdmin(context, sql)))
    throw new DataAccessError('authorization_denied');
  return context.actor.id;
}

/** Configuration publication requires a current login, including callers that
 * retained an old RequestContext. In a transaction these share locks order the
 * final publication against session revocation/user disablement. */
export async function requireCurrentPlatformAdmin(
  context: RequestContext,
  sql: Sql = getDatabase(),
) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  const actor = context.actor.id;
  const [session] = await sql`select s.id,u.email from allrice_sessions s
    join allrice_users u on u.id=s.user_id and u.status='active'
    where s.id=${UuidSchema.parse(context.sessionId)} and s.user_id=${actor}
      and s.revoked_at is null and s.expires_at>clock_timestamp()
    for share of s,u`;
  // Check the email version locked by this statement, not an earlier unlocked
  // administrator lookup. The publication transaction retains both row locks.
  if (!session || !platformAdminEmail(session.email))
    throw new DataAccessError('authorization_denied');
  return actor;
}
