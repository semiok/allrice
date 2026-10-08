import { nativeExcelAssetResponse } from '../../../../lib/chatflow/native-document-asset';
export const runtime = 'nodejs';
/** The exact pinned official client chunk, including spreadsheet parser worker and license notices. */
export async function GET(request: Request) {
  return nativeExcelAssetResponse(request);
}
