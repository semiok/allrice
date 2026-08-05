import {
  StorageObjectSchema,
  type StorageObject,
  type StoragePort,
} from '@allrice/contracts';

export interface S3CompatibleObjectClient {
  putObject(input: {
    bucket: string;
    key: string;
    body: ReadableStream<Uint8Array>;
    contentType: string;
    checksum: string;
  }): Promise<void>;
  getObject(input: {
    bucket: string;
    key: string;
  }): Promise<ReadableStream<Uint8Array>>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
  headObject(input: { bucket: string; key: string }): Promise<boolean>;
}

export class S3CompatibleStorageAdapter implements StoragePort {
  constructor(
    private readonly bucket: string,
    private readonly client: S3CompatibleObjectClient,
  ) {
    if (!bucket.trim()) throw new Error('S3-compatible bucket is required');
  }

  async put(objectInput: StorageObject, content: ReadableStream<Uint8Array>) {
    const object = StorageObjectSchema.parse(objectInput);
    await this.client.putObject({
      bucket: this.bucket,
      key: object.key,
      body: content,
      contentType: object.mediaType,
      checksum: object.checksum,
    });
  }

  async get(objectInput: StorageObject) {
    const object = StorageObjectSchema.parse(objectInput);
    return this.client.getObject({ bucket: this.bucket, key: object.key });
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
    await this.client.deleteObject({ bucket: this.bucket, key: object.key });
  }

  async exists(objectInput: StorageObject) {
    const object = StorageObjectSchema.parse(objectInput);
    return this.client.headObject({ bucket: this.bucket, key: object.key });
  }
}
