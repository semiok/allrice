import postgres from 'postgres';

let client: ReturnType<typeof postgres> | undefined;
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
    max: 5,
  });

  return client;
}

export async function pingDatabase() {
  await getDatabase()`select 1 as ready`;
}

export async function closeDatabase() {
  if (!client) return;
  for (const hook of closeHooks) await hook();
  await client.end({ timeout: 5 });
  client = undefined;
}
