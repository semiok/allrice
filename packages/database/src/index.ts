import postgres from 'postgres';

let client: ReturnType<typeof postgres> | undefined;

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
  await client.end({ timeout: 5 });
  client = undefined;
}

export * from './identity.ts';
export * from './data.ts';
export * from './workspace.ts';
export * from './queue.ts';
export * from './skillhub.ts';
export * from './employeehub.ts';
export * from './tool-broker.ts';
export * from './conversation-runtime.ts';
