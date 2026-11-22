import { Client } from 'pg';
import { z } from 'zod';
import {
  DEntrySelectionInputSchema,
  UuidSchema,
  sameDEntryIdentity,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase, registerDatabaseCloseHook } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  requireDEntryNativeIdentity,
  resolveDEntryIdentity,
} from './d-entry.ts';
import { getSessionExecutionGeneration } from './workspace/service.ts';

export const dEntryAuthorityChannel = 'allrice_d_entry_authority';
const changeSchema = z.object({
  schema: z.string(),
  table: z.string(),
  id: z.string().nullable(),
  organizationId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  personId: z.string().nullable(),
});
type Change = z.infer<typeof changeSchema>;
type Subscription = {
  changed(change: Change): void;
  lost(error: unknown): void;
};

/** One process-owned notification connection, not a permission cache. The
 * public pg error/end events fence subscribers at disconnect, before reconnect
 * could hide a missed notification. A new request opens a new connection. */
export function createDEntryAuthorityFeed(databaseUrl: string) {
  const listeners = new Set<Subscription>();
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'allrice-d-entry-authority',
    connectionTimeoutMillis: 5000, // Same database connect budget as the pool.
  });
  let unavailable: unknown;
  let failed = false;
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= client.end());
  const lost = (error: unknown) => {
    if (failed) return;
    failed = true;
    unavailable = error;
    for (const listener of listeners) listener.lost(error);
    listeners.clear();
    void close().catch(() => {}); // The process close hook joins this promise.
  };
  client.on('error', lost);
  client.on('end', () => lost(Error('D_ENTRY_AUTHORITY_DISCONNECTED')));
  client.on('notification', (message) => {
    if (message.channel !== dEntryAuthorityChannel) return;
    try {
      const change = changeSchema.parse(JSON.parse(message.payload ?? ''));
      for (const listener of listeners) listener.changed(change);
    } catch (error) {
      lost(error); // An unparseable authority announcement is not safe to ignore.
    }
  });
  const ready = (async () => {
    await client.connect();
    await client.query(`LISTEN ${dEntryAuthorityChannel}`);
    if (failed) throw unavailable;
  })();
  void ready.catch(lost);
  return {
    async subscribe(listener: Subscription, signal: AbortSignal) {
      const cancel = () => listener.lost(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        // Cancellation does not abandon a pending database connect/LISTEN.
        // Its actual promise still settles before the caller leaves setup.
        await ready;
        signal.throwIfAborted();
        if (failed) throw unavailable;
        listeners.add(listener);
        return () => listeners.delete(listener);
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },
    get available() {
      return !failed;
    },
    close() {
      lost(Error('D_ENTRY_AUTHORITY_CLOSED'));
      return close();
    },
  };
}
type Feed = ReturnType<typeof createDEntryAuthorityFeed>;
const feeds = new Set<Feed>(); // Only connections to join at process shutdown.
let currentFeed: Feed | undefined;
function defaultFeed() {
  if (!currentFeed?.available) {
    const url = process.env.DATABASE_URL;
    if (!url) throw Error('DATABASE_URL is required');
    currentFeed = createDEntryAuthorityFeed(url);
    feeds.add(currentFeed);
  }
  return currentFeed;
}
export async function closeDEntryAuthorityFeeds() {
  const results = await Promise.allSettled(
    [...feeds].map((feed) => feed.close()),
  );
  feeds.clear();
  currentFeed = undefined;
  const errors = results.flatMap((r) =>
    r.status === 'rejected' ? [r.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(errors, 'Authority connection close is unknown');
}
registerDatabaseCloseHook(closeDEntryAuthorityFeeds);

function affects(
  change: Change,
  context: RequestContext,
  identity: DEntryIdentity,
) {
  if (change.table === 'allrice_settings') return true; // Trigger selects this exact policy only.
  if (change.table === 'allrice_users') return change.id === identity.personId;
  if (change.table === 'allrice_sessions')
    return change.id === context.sessionId;
  if (change.table === 'allrice_organizations')
    return change.id === identity.organizationId;
  if (change.table === 'allrice_workspaces')
    return change.id === identity.workspaceId;
  if (
    change.organizationId &&
    change.organizationId !== identity.organizationId
  )
    return false;
  if (change.workspaceId && change.workspaceId !== identity.workspaceId)
    return false;
  if (change.personId && change.personId !== identity.personId) return false;
  if (change.table === 'allrice_employee_instances')
    return change.id === identity.employeeInstanceId;
  if (change.table === 'allrice_chat_sessions')
    return change.id === identity.threadId;
  return true;
}

export type DEntryAuthoritySubscription = Readonly<{
  revoked: AbortSignal;
  readonly expiresAt: string;
  close(): Promise<void>;
}>;

/** LISTEN is ready and the callback registered BEFORE this authoritative read.
 * A commit during setup either aborts the registered subscription or is seen
 * by the recheck. Never uses RequestContext's old membership/createdAt as TTL. */
async function watchDEntryAuthority(
  context: RequestContext,
  input: unknown,
  expected: DEntryIdentity,
  signal: AbortSignal,
  access: 'native' | 'history',
  feed?: Feed,
): Promise<DEntryAuthoritySubscription> {
  const selection = (
    access === 'history'
      ? DEntrySelectionInputSchema.extend({ threadId: UuidSchema })
      : DEntrySelectionInputSchema
  ).parse(input);
  signal.throwIfAborted();
  const source = feed ?? defaultFeed();
  const abort = new AbortController();
  const revoked = AbortSignal.any([signal, abort.signal]);
  let schema: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach: (() => unknown) | undefined;
  let stopped = false;
  let expiresAt = '';
  let checks = Promise.resolve();
  const invalidate = (error: unknown) => abort.abort(error);
  const recheck = async () => {
    if (stopped) return;
    revoked.throwIfAborted();
    const identity =
      access === 'history'
        ? await resolveDEntryIdentity(context, selection, 'history')
        : await requireDEntryNativeIdentity(context, selection);
    if (
      access === 'history' &&
      (!identity.threadId ||
        (await getSessionExecutionGeneration(
          context,
          identity.workspaceId,
          identity.threadId,
        )) !== '4.0')
    )
      throw new DataAccessError('authorization_denied');
    const [session] = await getDatabase()<
      {
        schema: string;
        expires_at: Date;
      }[]
    >`select current_schema() as schema,s.expires_at
      from allrice_sessions s where s.id=${context.sessionId} and s.user_id=${identity.personId}
        and s.revoked_at is null and s.expires_at>clock_timestamp()`;
    if (!session || !sameDEntryIdentity(identity, expected))
      throw new DataAccessError('authorization_denied');
    schema = session.schema;
    revoked.throwIfAborted();
    expiresAt = session.expires_at.toISOString();
    if (timer) clearTimeout(timer);
    // Actual session deadline, never session.created_at or an invented TTL.
    const deadline = session.expires_at.getTime();
    const expire = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        invalidate(new DataAccessError('authentication_required'));
      else {
        timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
        timer.unref();
      }
    };
    expire();
  };
  const enqueue = () => {
    if (!stopped) checks = checks.then(recheck).catch(invalidate);
  };
  const joinChecks = async () => {
    // A notification can append another real read while the preceding read is
    // settling. Join the whole chain, not only its first captured Promise.
    while (true) {
      const pending = checks;
      await pending;
      if (pending === checks) return;
    }
  };
  const close = async () => {
    stopped = true;
    detach?.();
    detach = undefined;
    if (timer) clearTimeout(timer);
    await joinChecks();
    if (timer) clearTimeout(timer); // A read already in flight may have armed it.
  };
  try {
    detach = await source.subscribe(
      {
        changed(change) {
          // NOTIFY is only a hint. Never grants/revokes authority from payload;
          // current SQL decides, including a permission change during setup.
          if (
            (!schema || change.schema === schema) &&
            affects(change, context, expected)
          )
            enqueue();
        },
        lost: invalidate,
      },
      revoked,
    );
    enqueue();
    await joinChecks();
    revoked.throwIfAborted();
    return {
      revoked,
      get expiresAt() {
        return expiresAt;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** VM-live eligibility retains the execute and published-4.0 verifier. */
export function watchDEntryNativeAuthority(
  context: RequestContext,
  input: unknown,
  expected: DEntryIdentity,
  signal: AbortSignal,
  feed?: Feed,
): Promise<DEntryAuthoritySubscription> {
  return watchDEntryAuthority(context, input, expected, signal, 'native', feed);
}

/** History-only current identity; close joins this subscription's reads, not
 * the shared feed, attachment ACL owner or any long-lived native job. */
export function watchDEntryHistoryAuthority(
  context: RequestContext,
  input: unknown,
  expected: DEntryIdentity,
  signal: AbortSignal,
  feed?: Feed,
): Promise<DEntryAuthoritySubscription> {
  return watchDEntryAuthority(
    context,
    input,
    expected,
    signal,
    'history',
    feed,
  );
}
