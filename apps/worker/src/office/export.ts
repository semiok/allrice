import { createHash } from 'node:crypto';
import {
  OfficeExportSchema,
  type ArtifactSourceFile,
  type DeliveryFormat,
} from '@allrice/contracts';
import { getToolBrokerFile } from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import { HandlerError } from '../errors.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';
import { createOffice } from './create.js';
import { editOffice } from './edit.js';
import { officeError, officeMediaTypes } from './package.js';

export async function readOfficeBytes(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 20 * 1024 * 1024) {
        await reader.cancel();
        officeError('Office 文件超过 20 MB');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function generateOfficeExport(
  input: RiceToolExecutionInput,
  format: DeliveryFormat,
  value: unknown,
) {
  if (JSON.stringify(value).length > 1_000_000)
    officeError('Office 结构化输入超过 1000000 字符');
  const office = OfficeExportSchema.parse(value);
  if (format !== 'docx' && format !== 'xlsx' && format !== 'pptx')
    officeError('Office 输入必须使用 docx、xlsx 或 pptx 格式');
  if (office.kind !== 'edit') {
    if (office.kind !== format) officeError('Office 类型与导出格式不一致');
    return {
      ...(await createOffice(office)),
      sourceFile: undefined,
      changes: undefined,
    };
  }
  if (!input.capabilities.includes('storage:read'))
    throw new HandlerError(
      'TOOL_CAPABILITY_DENIED',
      '修改原文件需要读取文件能力',
      false,
    );
  const file = await getToolBrokerFile(input.context, office.sourceObjectId);
  if (file.object.mediaType !== officeMediaTypes[format])
    officeError('源文件类型与编辑格式不一致');
  if (file.object.checksum !== office.sourceChecksum)
    officeError('源文件版本已变化，请重新读取文件');
  if (file.object.sizeBytes > 20 * 1024 * 1024)
    officeError('Office 文件超过 20 MB');
  const bytes = await readOfficeBytes(
    await new LocalStorageAdapter(input.storageRoot).get(file.object),
  );
  if (
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
    office.sourceChecksum
  )
    officeError('源文件内容与登记校验和不一致');
  const edited = await editOffice(bytes, format, office);
  const sourceFile: ArtifactSourceFile = {
    objectId: file.object.id,
    checksum: office.sourceChecksum,
  };
  return {
    ...edited,
    extension: `.${format}`,
    mediaType: officeMediaTypes[format],
    sourceFile,
  };
}
