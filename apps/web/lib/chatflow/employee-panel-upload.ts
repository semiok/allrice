import type { EmployeePanelDataClient } from './employee-panel-data';
import { fileToBase64 } from '../../app/chatflow/chatflow-utils';

/** Called by the existing upload intake, with its retained request ID. This
 * saves a new personal file; it does not fabricate a chat Attachment receipt. */
export async function uploadPersonalDeliverable(
  client: EmployeePanelDataClient,
  input: { workspaceId: string; requestId: string; file: File },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const contentBase64 = await fileToBase64(input.file);
  signal.throwIfAborted();
  const result = await client.uploadDeliverable(
    {
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      fileName: input.file.name,
      mediaType: input.file.type || 'application/octet-stream',
      contentBase64,
    },
    signal,
  );
  signal.throwIfAborted();
  window.dispatchEvent(new Event('allrice:workbench-files-changed'));
  return result;
}
