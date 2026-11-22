import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HostHistoryBindingSchema,
  HostHistorySnapshotSchema,
  type HostHistoryBinding,
  type HostHistorySnapshot,
  type HostHistoryStorePort,
} from '@allrice/contracts';

export class HostHistoryIntegrityError extends Error {
  constructor() {
    super('Host history integrity verification failed');
  }
}

/** Stable JSON hashing: neither object key insertion order nor raw path values
 * choose a storage location. Input must already be schema-validated JSON. */
export function hostHistoryDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item !== null && typeof item === 'object')
      return `{${Object.entries(item)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
        .join(',')}}`;
    const json = JSON.stringify(item);
    if (json === undefined) throw new HostHistoryIntegrityError();
    return json;
  };
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function compatible(a: HostHistorySnapshot, b: HostHistorySnapshot) {
  if (
    hostHistoryDigest(a.binding) !== hostHistoryDigest(b.binding) ||
    a.source.headerHash !== b.source.headerHash ||
    a.source.inheritedEventCount !== b.source.inheritedEventCount
  )
    throw new HostHistoryIntegrityError();
  if (
    a.source.throughSeq === b.source.throughSeq &&
    hostHistoryDigest(a) !== hostHistoryDigest(b)
  )
    throw new HostHistoryIntegrityError();
  const length = Math.min(
    a.source.eventHashes.length,
    b.source.eventHashes.length,
  );
  if (
    a.source.eventHashes
      .slice(0, length)
      .some((hash, i) => hash !== b.source.eventHashes[i])
  )
    throw new HostHistoryIntegrityError();
}

/** Host-owned, immutable projection storage. There is no mutable latest pointer,
 * execution state, lease, resume, retry or VM dependency. Concurrent same-content
 * exports converge on one atomic file; conflicting prefixes fail closed. */
export class HostHistoryStore implements HostHistoryStorePort {
  constructor(private readonly root: string) {
    if (!root.trim()) throw new HostHistoryIntegrityError();
  }

  private directory(binding: HostHistoryBinding) {
    return join(
      this.root,
      hostHistoryDigest(HostHistoryBindingSchema.parse(binding)).slice(7),
    );
  }

  async read(
    bindingInput: HostHistoryBinding,
    signal: AbortSignal,
    digest?: string,
  ) {
    signal.throwIfAborted();
    const binding = HostHistoryBindingSchema.parse(bindingInput);
    if (digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(digest))
      throw new HostHistoryIntegrityError();
    const directory = this.directory(binding);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let latest: { digest: string; snapshot: HostHistorySnapshot } | null = null;
    let selected: { digest: string; snapshot: HostHistorySnapshot } | null =
      null;
    const cursors = new Map<number, string>();
    for (const name of names) {
      signal.throwIfAborted();
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const handle = await open(
        join(directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let snapshot: HostHistorySnapshot;
      try {
        const bytes = await handle.readFile({ encoding: 'utf8', signal });
        snapshot = HostHistorySnapshotSchema.parse(JSON.parse(bytes));
      } catch {
        signal.throwIfAborted();
        throw new HostHistoryIntegrityError();
      } finally {
        await handle.close();
      }
      const actual = hostHistoryDigest(snapshot);
      if (
        `${actual.slice(7)}.json` !== name ||
        hostHistoryDigest(snapshot.binding) !== hostHistoryDigest(binding)
      )
        throw new HostHistoryIntegrityError();
      // Comparing only against the longest prefix can hide two conflicting
      // older projections after a restore, depending on directory order.
      const cursorDigest = cursors.get(snapshot.source.throughSeq);
      if (cursorDigest !== undefined && cursorDigest !== actual)
        throw new HostHistoryIntegrityError();
      cursors.set(snapshot.source.throughSeq, actual);
      if (latest) compatible(latest.snapshot, snapshot);
      if (
        !latest ||
        latest.snapshot.source.throughSeq < snapshot.source.throughSeq ||
        (latest.snapshot.source.throughSeq === snapshot.source.throughSeq &&
          actual < latest.digest)
      )
        latest = { digest: actual, snapshot };
      if (actual === digest) selected = { digest: actual, snapshot };
    }
    signal.throwIfAborted();
    return digest === undefined ? latest : selected;
  }

  async publish(input: HostHistorySnapshot, signal: AbortSignal) {
    signal.throwIfAborted();
    const snapshot = HostHistorySnapshotSchema.parse(input);
    const previous = await this.read(snapshot.binding, signal);
    if (previous) {
      compatible(previous.snapshot, snapshot);
      if (snapshot.source.throughSeq < previous.snapshot.source.throughSeq)
        throw new HostHistoryIntegrityError();
    }
    const digest = hostHistoryDigest(snapshot);
    const directory = this.directory(snapshot.binding);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(snapshot), {
        encoding: 'utf8',
        signal,
      });
      await handle.sync();
      await handle.close();
      signal.throwIfAborted();
      try {
        await link(temporary, join(directory, `${digest.slice(7)}.json`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const dir = await open(directory, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
    // A racing publication must also have the identical original prefix.
    await this.read(snapshot.binding, signal);
    return digest;
  }
}
