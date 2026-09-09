import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  LocalBrowserReceiptSchema,
  UuidSchema,
  type LocalBrowserReceipt,
} from '@allrice/contracts';
import {
  deleteCredentialRecordFile,
  readCredentialRecordFile,
  writeCredentialRecordFile,
} from './credential-files.js';

/** Local durable delivery outbox only, not an alternative Runtime authority.
 * UNKNOWN intent is persisted before renderer I/O; recovery only delivers it. */
export class LocalBrowserOutbox {
  readonly directory: string;
  constructor(
    configPath: string,
    private readonly server: string,
    private readonly deviceId: string,
  ) {
    this.directory = join(
      dirname(configPath),
      `${basename(configPath)}.browser-outbox-${createHash('sha256')
        .update(JSON.stringify([server, deviceId]))
        .digest('hex')
        .slice(0, 24)}`,
    );
  }
  private file(operationId: string) {
    return `${UuidSchema.parse(operationId)}.json`;
  }
  private async read(operationId: string) {
    const raw = await readCredentialRecordFile(
      this.directory,
      this.file(operationId),
    );
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw);
      if (
        value.version !== 1 ||
        value.server !== this.server ||
        value.deviceId !== this.deviceId ||
        Object.keys(value).some(
          (key) => !['version', 'server', 'deviceId', 'receipt'].includes(key),
        )
      )
        throw Error();
      const receipt = LocalBrowserReceiptSchema.parse(value.receipt);
      if (receipt.operationId !== operationId) throw Error();
      return receipt;
    } catch {
      throw Error('LOCAL_BROWSER_OUTBOX_UNSAFE');
    }
  }
  private async write(receipt: LocalBrowserReceipt) {
    await writeCredentialRecordFile(
      this.directory,
      this.file(receipt.operationId),
      JSON.stringify({
        version: 1,
        server: this.server,
        deviceId: this.deviceId,
        receipt: LocalBrowserReceiptSchema.parse(receipt),
      }),
    );
  }
  async prepare(receipt: LocalBrowserReceipt) {
    if (receipt.status !== 'unknown' || (await this.read(receipt.operationId)))
      throw Error('LOCAL_BROWSER_REPLAY_DENIED');
    await this.write(receipt);
  }
  async complete(receipt: LocalBrowserReceipt) {
    const previous = await this.read(receipt.operationId);
    if (
      !previous ||
      previous.receiptId !== receipt.receiptId ||
      previous.operationLeaseToken !== receipt.operationLeaseToken ||
      previous.workspaceId !== receipt.workspaceId ||
      previous.controllerLeaseToken !== receipt.controllerLeaseToken ||
      previous.status !== 'unknown'
    )
      throw Error('LOCAL_BROWSER_OUTBOX_UNSAFE');
    await this.write(receipt);
  }
  async pending() {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw Error('LOCAL_BROWSER_OUTBOX_UNSAFE');
    }
    if (names.length > 128) throw Error('LOCAL_BROWSER_OUTBOX_FULL');
    const receipts: LocalBrowserReceipt[] = [];
    for (const name of names) {
      if (
        !name.endsWith('.json') ||
        !UuidSchema.safeParse(name.slice(0, -5)).success
      )
        throw Error('LOCAL_BROWSER_OUTBOX_UNSAFE');
      const receipt = await this.read(name.slice(0, -5));
      if (receipt) receipts.push(receipt);
    }
    return receipts;
  }
  async acknowledge(receipt: LocalBrowserReceipt) {
    const previous = await this.read(receipt.operationId);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(receipt))
      throw Error('LOCAL_BROWSER_OUTBOX_UNSAFE');
    await deleteCredentialRecordFile(
      this.directory,
      this.file(receipt.operationId),
    );
  }
}
