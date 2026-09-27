import postgres from 'postgres';

let client: ReturnType<typeof postgres> | undefined;
let diagnostics: ReturnType<typeof postgres> | undefined;
const closeHooks = new Set<() => Promise<void>>();

export function registerDatabaseCloseHook(hook: () => Promise<void>) {
  closeHooks.add(hook);
  return () => closeHooks.delete(hook);
}

export function getDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  client ??= postgres(databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 20,
    max: process.env.ALLRICE_SERVICE_ROLE === 'worker' ? 10 : 5,
    connection: {
      application_name: `allrice-${process.env.ALLRICE_SERVICE_ROLE === 'worker' ? 'worker' : 'app'}`,
    },
  });

  return client;
}

export async function pingDatabase() {
  await getDatabase()`select 1 as ready`;
}

/** One bounded connection keeps lock diagnostics available when the business
 * pool is occupied. It never executes tenant queries or long transactions. */
export function getDiagnosticsDatabase() {
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is required');
  diagnostics ??= postgres(process.env.DATABASE_URL, {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 20,
    connection: {
      application_name: 'allrice-diagnostics',
      statement_timeout: 1500,
      lock_timeout: 500,
    },
  });
  return diagnostics;
}

export async function closeDatabase() {
  await diagnostics?.end({ timeout: 2 });
  diagnostics = undefined;
  if (!client) return;
  for (const hook of closeHooks) await hook();
  await client.end({ timeout: 5 });
  client = undefined;
}
