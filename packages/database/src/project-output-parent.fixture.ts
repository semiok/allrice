// Isolated integration fixtures only: no real execution is represented.
import { randomUUID, createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { ExecutionContext, StoragePort } from '@allrice/contracts';
import type { getDatabase } from './core/client.ts';
import { createToolBrokerExportObject } from './execution/tool-broker.ts';

type Database = ReturnType<typeof getDatabase>;
export async function seedProjectOutputParent(input: {
  db: Database;
  storage: StoragePort;
  context: ExecutionContext;
  sessionId: string;
  ownerId?: string;
  bytes: Buffer;
  kind?: 'document' | 'file' | null;
  deleted?: boolean;
}) {
  const owner = input.ownerId ?? input.context.policySnapshot.subjectId;
  const context = {
    ...input.context,
    policySnapshot: { ...input.context.policySnapshot, subjectId: owner },
  };
  const object = {
    ...createToolBrokerExportObject({
      context,
      mediaType: 'application/zip',
      sizeBytes: input.bytes.length,
      checksum:
        'sha256:' + createHash('sha256').update(input.bytes).digest('hex'),
    }),
    immutable: true,
  };
  await input.storage.put(
    object,
    new Blob([Uint8Array.from(input.bytes)]).stream(),
  );
  const id = randomUUID(),
    seriesId = randomUUID(),
    db = input.db;
  await db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable,deleted_at)
    values(${object.id},${context.organizationId},${context.workspaceId!},${owner},${object.key},'exports',${object.mediaType},${object.sizeBytes},${object.checksum},${input.deleted ? 'deleted' : 'ready'},true,${input.deleted ? new Date() : null})`;
  await db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format)
    values(${id},${context.organizationId},${context.workspaceId!},${owner},${object.id},${seriesId},1,${input.sessionId},'prior-project.zip','zip')`;
  if (input.kind !== null)
    await db`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest)
    values(${id},${context.organizationId},${context.workspaceId!},${owner},${context.runId},${input.kind ?? 'document'},${db.json({ kind: 'model_proposal', runId: context.runId, operationId: null, stepId: null })},${'fixture:' + randomUUID()},${'sha256:' + createHash('sha256').update(input.bytes).digest('hex')})`;
  return {
    objectId: object.id,
    versionId: id,
    seriesId,
    checksum: object.checksum,
  };
}

/** Hold the first real publication in storage I/O; observe a second PostgreSQL
 * backend blocked by that transaction before releasing it. No sleep-only race. */
export async function raceProjectPublications<T>(input: {
  db: Database;
  storage: StoragePort;
  organizationId: string;
  workspaceId: string;
  first: () => Promise<T>;
  second: () => Promise<T>;
}) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = input.storage.put.bind(input.storage);
  let held = false;
  const spy = vi
    .spyOn(input.storage, 'put')
    .mockImplementation(async (...args) => {
      if (!held) {
        held = true;
        await released;
      }
      return put(...args);
    });
  const first = input.first();
  void first.catch(() => {});
  let second: Promise<T> | undefined;
  let blocked: { holder: number; waiter: number } | undefined;
  try {
    await vi.waitFor(
      () => {
        if (!held) throw Error('First publication never entered storage');
      },
      { timeout: 4000, interval: 20 },
    );
    second = input.second();
    void second.catch(() => {});
    const key = input.organizationId + ':' + input.workspaceId;
    await vi.waitFor(
      async () => {
        const rows = await input.db<{ holder: number; waiter: number }[]>`
        select q.pid as holder,a.pid as waiter from pg_locks q
        join pg_stat_activity a on q.pid=any(pg_blocking_pids(a.pid))
        where q.locktype='advisory' and q.granted and q.objsubid=1
          and q.database=(select oid from pg_database where datname=current_database())
          and q.classid=((hashtextextended(${key},42)>>32)&4294967295)::oid
          and q.objid=(hashtextextended(${key},42)&4294967295)::oid
          and a.pid<>q.pid`;
        if (!rows.length)
          throw Error(
            'Second publication has no independently observed blocked backend',
          );
        blocked = rows[0];
      },
      { timeout: 4000, interval: 20 },
    );
    release();
    return {
      blocked: blocked!,
      results: await Promise.allSettled([first, second]),
    };
  } finally {
    release();
    await Promise.allSettled(second ? [first, second] : [first]);
    spy.mockRestore();
  }
}

export async function raceQueuedOutputPublications<T>(input: {
  db: Database;
  organizationId: string;
  workspaceId: string;
  first: () => Promise<T>;
  second: () => Promise<T>;
}) {
  let ready!: () => void, release!: () => void;
  const acquired = new Promise<void>((resolve) => {
      ready = resolve;
    }),
    released = new Promise<void>((resolve) => {
      release = resolve;
    });
  const key = input.organizationId + ':' + input.workspaceId;
  const gate = input.db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${key},42))`;
    ready();
    await released;
  });
  let first: Promise<T> | undefined, second: Promise<T> | undefined;
  try {
    await acquired;
    first = input.first();
    void first.catch(() => {});
    second = input.second();
    void second.catch(() => {});
    await vi.waitFor(
      async () => {
        const [row] = await input.db<
          { n: number }[]
        >`select count(distinct pid)::int n from pg_locks
        where locktype='advisory' and not granted and objsubid=1
          and database=(select oid from pg_database where datname=current_database())
          and classid=((hashtextextended(${key},42)>>32)&4294967295)::oid
          and objid=(hashtextextended(${key},42)&4294967295)::oid`;
        if (row?.n !== 2)
          throw Error(
            'Two independently blocked publisher backends not observed',
          );
      },
      { timeout: 4000, interval: 20 },
    );
    release();
    await gate;
    return await Promise.allSettled([first, second]);
  } finally {
    release();
    await gate;
    await Promise.allSettled([
      ...(first ? [first] : []),
      ...(second ? [second] : []),
    ]);
  }
}
