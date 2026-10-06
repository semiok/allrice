import JSZip from 'jszip';
import { Readable } from 'node:stream';
import { RepositoryCiReceiptSchema } from '@allrice/database/technical-contracts';
import { checkZip } from '../office/package.js';
import { RepositoryRemoteError } from './github.js';
/** Reuse the existing duplicate/path ZIP checker with narrow receipt limits. */
export async function readRepositoryCiArtifact(bytes: Buffer) {
  try {
    checkZip(bytes, {
      maxBytes: 400000,
      maxEntries: 1,
      maxMemberBytes: 100000,
      maxExpandedBytes: 100000,
    });
    const zip = await JSZip.loadAsync(bytes),
      names = Object.keys(zip.files);
    if (
      names.length !== 1 ||
      names[0] !== 'receipt.json' ||
      zip.files['receipt.json']!.dir
    )
      throw Error('CI_ARTIFACT_CONTENT');
    const chunks: Buffer[] = [];
    let length = 0;
    // JSZip uses readable-stream 2, which has no async iterator. Adapt it to Node's bounded reader.
    for await (const chunk of new Readable().wrap(
      zip.files['receipt.json']!.nodeStream('nodebuffer'),
    )) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > 100000) throw Error('CI_ARTIFACT_LIMIT');
      chunks.push(bytes);
    }
    return RepositoryCiReceiptSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
  } catch {
    throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
  }
}
