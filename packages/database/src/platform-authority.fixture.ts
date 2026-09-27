/** Test setup only: explicit platform identity, independent of the membership role. */
import { vi } from 'vitest';
import type postgres from 'postgres';
export async function authorizeFixturePlatformAdministrator(
  db: ReturnType<typeof postgres> | postgres.TransactionSql,
  userId: string,
) {
  const [user] = await db`select email from allrice_users where id=${userId}`;
  if (!user) throw Error('Fixture platform user must exist');
  vi.stubEnv(
    'ALLRICE_PLATFORM_ADMIN_EMAILS',
    [
      ...new Set([
        ...(process.env.ALLRICE_PLATFORM_ADMIN_EMAILS ?? '')
          .split(',')
          .filter(Boolean),
        user.email as string,
      ]),
    ].join(','),
  );
}
