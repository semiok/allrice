import postgres from 'postgres';

import { closeChatFlowWakeups } from './chatflow-notifications.ts';

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
  await closeChatFlowWakeups();
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
export * from './conversation-checkpoint.ts';
export * from './conversation-usage.ts';
export * from './conversation-input.ts';
export * from './automation.ts';
export * from './capability-registry.ts';
export * from './route-decision.ts';
export * from './knowledge-retrieval.ts';
export * from './connector-broker.ts';
export * from './workflow-runtime.ts';
export * from './chatflow-notifications.ts';
export * from './model-pool.ts';
export * from './provider-auth.ts';
export * from './model-governance.ts';
export * from './employee-quality.ts';
