import { hasOnlineOwnedBridgeDevice } from '../bridge.ts';
import type { ContentSql } from './employee-content-model.ts';

// The approved local tool group only. Browser and MCP have their own admission
// contracts; do not infer group membership from a prefix or broaden this list.
const connectedDeviceTools = new Set([
  'local.fs.list',
  'local.fs.search',
  'local.fs.read',
  'local.fs.write',
  'local.fs.mkdir',
  'local.git.status',
  'local.git.diff',
  'local.process.execute',
  'local.process.status',
  'local.process.stop',
  'local.file.inspect',
  'local.file.derive',
  'local.file.save',
  'local.preview.open',
]);

/** Call only when admitting a new Run. A later connection cannot expand its
 * frozen allowlist, and an old Run is never recomputed against current presence. */
export async function freezeConnectedLocalToolNames(
  toolNames: string[],
  scope: { organizationId: string; workspaceId: string; ownerId: string },
  sql: ContentSql,
) {
  if (!toolNames.some((name) => connectedDeviceTools.has(name)))
    return toolNames;
  if (await hasOnlineOwnedBridgeDevice(scope, sql)) return toolNames;
  return toolNames.filter((name) => !connectedDeviceTools.has(name));
}
