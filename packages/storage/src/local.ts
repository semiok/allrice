import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import {
  ObjectKeySchema,
  StorageObjectSchema,
  type StorageObject,
  type StoragePort,
} from '@allrice/contracts';

function objectPath(root: string, key: string) {
  const parsed = ObjectKeySchema.parse(key);
  const normalizedRoot = resolve(root);
  const path = resolve(normalizedRoot, parsed);
  if (!path.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error('storage key escapes configured root');
  }
  return path;
}

export class LocalStorageAdapter implements StoragePort {
  constructor(private readonly root: string) {
    if (!root.trim()) throw new Error('storage root is required');
  }

  async put(objectInput: StorageObject, content: ReadableStream<Uint8Array>) {
    const object = StorageObjectSchema.parse(objectInput);
    const destination = objectPath(this.root, object.key);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    const reader = content.getReader();
    const hash = createHash('sha256');
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        hash.update(chunk.value);
        await handle.write(chunk.value);
      }
      await handle.sync();
      await handle.close();
      const checksum = `sha256:${hash.digest('hex')}`;
      if (size !== object.sizeBytes || checksum !== object.checksum) {
        await rm(temporary, { force: true });
        throw new Error(
          'storage content does not match declared size/checksum',
        );
      }
      await rename(temporary, destination);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async get(objectInput: StorageObject) {
    const object = StorageObjectSchema.parse(objectInput);
    const content = await readFile(objectPath(this.root, object.key));
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(content);
        controller.close();
      },
    });
  }

  async delete(objectInput: StorageObject) {
    const object = StorageObjectSchema.parse(objectInput);
    if (object.immutable)
      throw new Error('immutable storage object cannot be deleted');
    if (
      object.retentionUntil &&
      Date.parse(object.retentionUntil) > Date.now()
    ) {
      throw new Error('storage object is still retained');
    }
    await rm(objectPath(this.root, object.key), { force: true });
  }

  async exists(objectInput: StorageObject) {
    const object = StorageObjectSchema.parse(objectInput);
    try {
      return (await stat(objectPath(this.root, object.key))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
