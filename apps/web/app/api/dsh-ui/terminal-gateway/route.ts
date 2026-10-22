import { nativeTerminalAssetResponse } from '../../../../lib/chatflow/native-terminal-asset';
export const runtime = 'nodejs';
export const GET = (request: Request) =>
  nativeTerminalAssetResponse('gateway', request);
