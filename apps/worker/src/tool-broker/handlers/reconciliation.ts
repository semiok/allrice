import { getWorkbenchArtifact, readArtifactBytes } from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import { UuidSchema } from '@allrice/contracts';
import { z } from 'zod';
import { reconciliationWorkbook } from '../../reconciliation-workbook.js';
import { HandlerError } from '../../errors.js';
import type { RiceToolHandler } from '../types.js';
import { publishReconciliationWorkbook } from '@allrice/database';

export const exportReconciliation: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const query = z
    .object({
      artifactId: UuidSchema,
      fileName: z.string().trim().min(1).max(120),
      parentObjectId: UuidSchema.optional(),
    })
    .strict()
    .parse(args);
  if (!input.sessionId)
    throw new HandlerError('TOOL_SESSION_REQUIRED', '需要当前对话', false);
  const principal = {
    actor: input.context.delegatedBy,
    organizationId: input.context.organizationId,
    workspaceId: input.context.workspaceId,
  };
  const source = await getWorkbenchArtifact(
    principal,
    input.sessionId,
    query.artifactId,
  );
  if (
    source.provenance.kind !== 'tool_result' ||
    source.provenance.runId !== input.context.runId ||
    source.execution?.targetKind !== 'cloud_sandbox' ||
    source.object.mediaType !== 'application/json'
  )
    throw new HandlerError(
      'TOOL_SOURCE_INVALID',
      '只能使用当前 Run 云端已确认的对账 JSON 工件',
      false,
    );
  const storage = new LocalStorageAdapter(input.storageRoot);
  const bytes = await readArtifactBytes(storage, source.object, 2_000_000);
  const generated = await reconciliationWorkbook(
    JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
    { objectId: source.object.id, checksum: source.object.checksum },
  );
  const fileName =
    Array.from(query.fileName, (c) =>
      c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? '-' : c,
    )
      .join('')
      .replace(/\.xlsx$/i, '') + '.xlsx';
  const artifact = await publishReconciliationWorkbook(
    {
      context: input.context,
      sessionId: input.sessionId,
      callId: input.call.id,
      sourceArtifactId: source.id,
      fileName,
      bytes: generated.bytes,
      ...(query.parentObjectId ? { parentObjectId: query.parentObjectId } : {}),
    },
    storage,
  );
  return {
    modelContent: JSON.stringify({
      artifactId: artifact.id,
      objectId: artifact.object.id,
      sourceObjectId: source.object.id,
      sourceChecksum: source.object.checksum,
      fileName,
      version: artifact.version.version,
      totals: generated.report.totals,
      downloadUrl: `/api/v1/files/${artifact.object.id}/download?name=${encodeURIComponent(fileName)}`,
    }),
    summary: `已按云端确定性结果导出对账表 · v${artifact.version.version}`,
    itemCount: generated.report.rows.length,
  };
};
