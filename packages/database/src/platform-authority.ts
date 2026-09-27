import type postgres from 'postgres';
import type { RequestContext } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
type Principal = Pick<RequestContext, 'actor'>;

/** Platform administration is independent of a tenant's historical role. */
export async function isPlatformAdmin(context: Principal, sql?: Sql) {
  if (context.actor.type !== 'user') return false;
  const db = sql ?? getDatabase();
  const [user] = await db<{ email: string }[]>`
    select email from allrice_users where id=${context.actor.id} and status='active'
  `;
  const emails = new Set(
    (process.env.ALLRICE_PLATFORM_ADMIN_EMAILS ?? 'semiokshen@gmail.com')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  return !!user && emails.has(user.email.toLowerCase());
}

export async function requirePlatformAdmin(context: Principal, sql?: Sql) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  if (!(await isPlatformAdmin(context, sql)))
    throw new DataAccessError('authorization_denied');
  return context.actor.id;
}
