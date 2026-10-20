import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { explicitRecurringTaskIntent } from '@allrice/database';
import { HandlerError } from '../../errors.js';
import { isDshNativeTool, privateDshNativeToolNames } from './tool-bridge.js';

export function nativeSessionRecoveryFailure(error: unknown) {
  const toolMismatch =
    error instanceof Error &&
    /^tools\.restrict\(\) names unknown global tool "[a-zA-Z0-9_]+";/.test(
      error.message,
    );
  return new HandlerError(
    toolMismatch
      ? 'DSH_NATIVE_TOOL_CAPABILITY_MISMATCH'
      : 'DSH_NATIVE_SESSION_STORAGE_UNAVAILABLE',
    toolMismatch
      ? '原会话执行包与本轮工具清单不兼容，资料和执行记录已保留。'
      : '原会话恢复失败，资料和执行记录已保留。',
    false,
  );
}

/** The selected, already verified artifact owns its native tool vocabulary.
 * A new Worker capability can still use the existing Broker envelope when an
 * older pinned runtime cannot register its native function. */
export async function selectDshNativeTools(
  names: readonly string[],
  verifiedEntrypoint?: string,
  currentUserRequest?: string,
) {
  // Only the server-loaded current human message selects this transport.
  // Kernel text can include untrusted templates; a missing raw message keeps
  // the prior native vocabulary. SQL still authorizes the eventual operation.
  const recurring =
    names.includes('automation.create') &&
    currentUserRequest !== undefined &&
    explicitRecurringTaskIntent(currentUserRequest) !== null;
  const requested = names.filter(
    (name) =>
      isDshNativeTool(name) && !(recurring && name === 'automation.create'),
  );
  if (!verifiedEntrypoint) return requested; // offline protocol fixtures
  const require = createRequire(verifiedEntrypoint);
  const module = await import(
    pathToFileURL(require.resolve('@allrice/contracts')).href
  );
  const manifest: unknown = module.allRiceToolManifest;
  if (!Array.isArray(manifest))
    throw new HandlerError(
      'DSH_NATIVE_TOOL_CATALOG_UNAVAILABLE',
      '原会话执行包的工具目录暂不可用，已保留原记录。',
      false,
    );
  const supported = new Set(
    manifest
      .filter(
        (tool) =>
          typeof tool?.canonicalName === 'string' &&
          typeof tool.transport === 'string' &&
          tool.transport !== 'envelope',
      )
      .map((tool) => tool.canonicalName as string),
  );
  return requested.filter(
    (name) => supported.has(name) || privateDshNativeToolNames.has(name),
  );
}
