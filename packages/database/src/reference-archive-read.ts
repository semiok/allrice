import { createHash } from 'node:crypto';
import {
  ReferenceArchiveListInputSchema,
  ReferenceArchiveReadInputSchema,
  ReferenceContentCallSchema,
  ReferenceImageRouteResultSchema,
  ReferenceReadImageInputSchema,
  type ReferenceImageCitation,
  type ReferenceArchiveCitationSchema,
  type ReferenceMemberIdentity,
  type ReferenceSelection,
} from '@allrice/contracts';
import {
  openReferenceArchive,
  FileArchiveError,
  referenceArchivePolicy,
} from '@allrice/file-archives';
import type { z } from 'zod';
import type { ContentIdentity } from './content-maintenance.ts';
import { getDatabase } from './core/client.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { referenceCitationLabel } from './reference-runtime.ts';
import { referenceTextPage } from './reference-search.ts';
import { validateReferenceFullText } from './reference-fulltext.ts';
import {
  requireReferenceImagePin,
  readReferenceBytes,
  prepareReferenceImageBytes,
  ReferenceImageReadError,
  referenceImageLimit,
  checkReferenceImageSignal,
  type ReferenceImageExecution,
} from './reference-image-read.ts';
import { inspectReferenceImage } from './reference-image.ts';

type ArchiveLocator = z.infer<typeof ReferenceArchiveCitationSchema>['locator'];
export type PreparedReferenceContent = {
  selection: ReferenceSelection;
  readKind: 'image' | 'archive_directory' | 'archive_member_text';
  locator: ArchiveLocator | ReferenceImageCitation['locator'] | null;
  contentChecksum: string;
  value: Record<string, unknown>;
  itemCount: number;
};
export class ReferenceArchiveInputError extends Error {
  readonly code = 'TOOL_INPUT_INVALID';
  constructor() {
    super(
      '请使用同一资料目录给出的 entryId/cursor，以及正文返回的偏移和摘要。',
    );
  }
}
const sha = (value: Uint8Array | string) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
function unsupported(
  reason:
    'media_type' | 'nested_archive' | 'directory_entry' | 'text_unavailable',
): never {
  throw new ReferenceImageReadError({
    code: 'REFERENCE_READ_UNSUPPORTED',
    reason,
    message: '该成员不支持所请求的读取方式；原 ZIP 仍可按原权限下载。',
    retryable: false,
  });
}
function candidate(path: string): 'text' | 'image' | null {
  const extension = path.toLowerCase().split('.').pop();
  if (['png', 'jpg', 'jpeg'].includes(extension ?? '')) return 'image';
  if (
    [
      'txt',
      'md',
      'markdown',
      'json',
      'csv',
      'pdf',
      'docx',
      'xlsx',
      'pptx',
    ].includes(extension ?? '')
  )
    return 'text';
  return null;
}

export async function prepareReferenceArchive(
  reader: ContentIdentity,
  toolName:
    'workspace.reference.archive_list' | 'workspace.reference.archive_read',
  input: unknown,
  execution: ReferenceImageExecution,
  signal: AbortSignal,
  authorize: () => Promise<void>,
): Promise<PreparedReferenceContent> {
  ReferenceContentCallSchema.parse(execution.call);
  if (execution.call.name !== toolName) throw new ReferenceArchiveInputError();
  const args =
    toolName === 'workspace.reference.archive_list'
      ? ReferenceArchiveListInputSchema.parse(input)
      : ReferenceArchiveReadInputSchema.parse(input);
  const pin = ReferenceReadImageInputSchema.parse({
    sourceId: args.sourceId,
    revisionId: args.revisionId,
    digest: args.digest,
    checksum: args.checksum,
  });
  const current = await requireReferenceImagePin(
    reader,
    pin,
    getDatabase(),
    false,
    'archive',
  );
  // Even the parent bytes are not read on an unsupported image route.
  if ('as' in args && args.as === 'image') {
    const route = ReferenceImageRouteResultSchema.parse(
      await execution.native.route(),
    );
    if ('error' in route) throw new ReferenceImageReadError(route.error);
  }
  checkReferenceImageSignal(signal);
  const data = await readReferenceBytes(
    execution.storage,
    current.object,
    referenceArchivePolicy.maximumBytes,
    'archive_bytes',
    signal,
  );
  // A non-ZIP publication is not a malformed ZIP request. Preserve malformed
  // ZIP errors for actual ZIP signatures, independent of the uploaded suffix.
  if (
    data.length < 4 ||
    ![0x04034b50, 0x06054b50, 0x06064b50].includes(data.readUInt32LE(0))
  )
    unsupported('media_type');
  try {
    const archive = await openReferenceArchive(data, {
      signal,
      authorize: async () => {
        await authorize();
        return true;
      },
    });
    try {
      // Office packages are document inputs, never top-level archive aliases.
      if (archive.entries.some((entry) => entry.path === '[Content_Types].xml'))
        unsupported('media_type');
      const selection = current.selection;
      const pinDigest = runtimePolicyDigest(pin);
      const entries = archive.entries.map((entry) => ({
        entryId:
          'entry:' +
          runtimePolicyDigest({
            pin,
            index: entry.index,
            identity: entry.identity,
          }),
        path: entry.path,
        kind: entry.kind,
        compressedBytes: entry.compressedBytes,
        declaredBytes: entry.declaredBytes,
        compression: entry.compression,
        readAs: entry.kind === 'directory' ? null : candidate(entry.path),
        contentVerification: 'not_read' as const,
      }));
      await authorize();
      if (!('as' in args)) {
        const start = args.cursor?.nextEntryIndex ?? 0;
        if (
          args.cursor &&
          (args.cursor.pinDigest !== pinDigest ||
            args.cursor.directoryChecksum !== archive.directoryChecksum ||
            start >= entries.length)
        )
          throw new ReferenceArchiveInputError();
        let count = Math.min(args.limit, entries.length - start);
        while (true) {
          const end = start + count;
          const value = {
            kind: 'archive_directory' as const,
            reference: selection,
            directoryChecksum: archive.directoryChecksum,
            totalEntries: entries.length,
            entries: entries.slice(start, end),
            nextCursor:
              end < entries.length
                ? {
                    version: 1 as const,
                    pinDigest,
                    directoryChecksum: archive.directoryChecksum,
                    nextEntryIndex: end,
                  }
                : null,
            warnings: [] as string[],
          };
          const contentChecksum = runtimePolicyDigest(value);
          const locator = {
            kind: 'archive_directory' as const,
            directoryChecksum: archive.directoryChecksum,
            startEntryIndex: start,
            endEntryIndex: end,
            totalEntries: entries.length,
            pageChecksum: contentChecksum,
          };
          // Reserve the complete worst-length receipt envelope before locking.
          const id = '00000000-0000-4000-8000-000000000000';
          const result = {
            ...value,
            citation: {
              type: 'reference',
              id,
              label: referenceCitationLabel(selection),
              reference: selection,
              referenceLabel: 'R64',
              locator,
            },
            receiptId: id,
          };
          if (JSON.stringify(result).length <= 12_000)
            return {
              selection,
              readKind: 'archive_directory',
              locator,
              contentChecksum,
              value,
              itemCount: count,
            };
          if (count <= 1)
            referenceImageLimit(
              'directory_result',
              '目录项及来源超过结果容量，未截断成员名称。',
            );
          count--;
        }
      }
      const index = entries.findIndex(
        (entry) => entry.entryId === args.entryId,
      );
      if (index < 0) throw new ReferenceArchiveInputError();
      const entry = entries[index]!;
      if (entry.kind === 'directory') unsupported('directory_entry');
      const extension = entry.path.toLowerCase().split('.').pop() ?? '';
      if (['zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz'].includes(extension))
        unsupported('nested_archive');
      if (
        ['exe', 'dll', 'com', 'bat', 'cmd', 'sh', 'ps1', 'app'].includes(
          extension,
        )
      )
        unsupported('media_type');
      const bytes = await archive.readMember(index);
      await authorize();
      checkReferenceImageSignal(signal);
      const checksum = sha(bytes);
      if (
        bytes.length >= 4 &&
        [0x04034b50, 0x06054b50, 0x06064b50].includes(bytes.readUInt32LE(0)) &&
        (args.as === 'image' || !['docx', 'xlsx', 'pptx'].includes(extension))
      )
        unsupported('nested_archive');
      if (args.as === 'image') {
        const image = await prepareReferenceImageBytes(
          bytes,
          entry.path,
          execution.native,
          signal,
        );
        const facts = inspectReferenceImage(bytes, false)!;
        const member: ReferenceMemberIdentity = {
          entryId: args.entryId,
          path: entry.path,
          checksum,
          sizeBytes: bytes.length,
          mediaType: facts.mediaType,
        };
        const locator = {
          kind: 'image' as const,
          member,
          sourceChecksum: checksum,
          image,
        };
        return {
          selection,
          readKind: 'image',
          locator,
          contentChecksum: image.attachmentId,
          itemCount: 1,
          value: {
            kind: 'image',
            reference: selection,
            member,
            sourceChecksum: checksum,
            image,
            warnings: [],
          },
        };
      }
      if (!execution.parseText) unsupported('text_unavailable');
      const parsed = await execution.parseText(bytes, entry.path, signal);
      checkReferenceImageSignal(signal);
      const fullText = validateReferenceFullText(parsed.fullText);
      const textChecksum = sha(fullText.text);
      if (
        args.expectedTextChecksum &&
        args.expectedTextChecksum !== textChecksum
      )
        throw new ReferenceArchiveInputError();
      const page = referenceTextPage({ fullText }, args.offset, args.limit);
      const member: ReferenceMemberIdentity = {
        entryId: args.entryId,
        path: entry.path,
        checksum,
        sizeBytes: bytes.length,
        mediaType: parsed.mediaType,
      };
      const locator = page.content.length
        ? {
            kind: 'archive_member_text' as const,
            member,
            textChecksum,
            start: page.start,
            end: page.end,
            locations: page.locations,
          }
        : null;
      return {
        selection,
        readKind: 'archive_member_text',
        locator,
        contentChecksum: sha(page.content),
        itemCount: page.content.length ? 1 : 0,
        value: {
          kind: 'archive_member_text',
          reference: selection,
          member,
          ...page,
          textChecksum,
        },
      };
    } finally {
      archive.close();
    }
  } catch (error) {
    checkReferenceImageSignal(signal);
    if (error instanceof FileArchiveError) {
      if (error.code === 'FILE_ARCHIVE_AUTHORITY_LOST') await authorize();
      throw new ReferenceImageReadError({
        code:
          error.code === 'FILE_ARCHIVE_LIMIT'
            ? 'REFERENCE_READ_LIMIT'
            : error.code === 'FILE_ARCHIVE_UNSUPPORTED'
              ? 'REFERENCE_READ_UNSUPPORTED'
              : 'REFERENCE_READ_INVALID',
        reason: error.reason ?? 'archive_structure',
        message: '该 ZIP 未通过安全读取校验，未返回部分内容。',
        retryable: false,
      });
    }
    throw error;
  }
}
