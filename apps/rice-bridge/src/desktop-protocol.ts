export const desktopMaximumFrameBytes = 16_384;
const hasControl = (value: string) =>
  [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
export type DesktopRequest = { v: 1; id: string } & (
  | {
      type:
        | 'status'
        | 'pause'
        | 'resume'
        | 'prepare'
        | 'diagnostics'
        | 'stop'
        | 'updateStatus'
        | 'drain'
        | 'recoverUpdate';
    }
  | { type: 'installUpdate'; version: string }
  | { type: 'pair'; server: string; code: string }
  | { type: 'workspace'; path: string }
  | { type: 'picker'; pickerId: string; path: string | null }
  | { type: 'revoke'; confirmDeviceId: string }
  | { type: 'browser' | 'preview'; enabled: boolean }
);

/** Strict local-control schema. It cannot represent a shell or tool request. */
export function parseDesktopRequest(bytes: string): DesktopRequest {
  if (Buffer.byteLength(bytes) > desktopMaximumFrameBytes)
    throw Error('DESKTOP_FRAME_LIMIT');
  const value: unknown = JSON.parse(bytes);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('DESKTOP_REQUEST_INVALID');
  const row = value as Record<string, unknown>;
  if (
    row.v !== 1 ||
    typeof row.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) ||
    typeof row.type !== 'string'
  )
    throw Error('DESKTOP_REQUEST_INVALID');
  const keys: Record<string, string[]> = {
    status: [],
    pause: [],
    resume: [],
    prepare: [],
    diagnostics: [],
    stop: [],
    updateStatus: [],
    drain: [],
    recoverUpdate: [],
    installUpdate: ['version'],
    pair: ['server', 'code'],
    workspace: ['path'],
    picker: ['pickerId', 'path'],
    revoke: ['confirmDeviceId'],
    browser: ['enabled'],
    preview: ['enabled'],
  };
  if (!Object.hasOwn(keys, row.type)) throw Error('DESKTOP_REQUEST_INVALID');
  if (
    row.type === 'installUpdate' &&
    (typeof row.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-dev\.\d+)?$/.test(row.version) ||
      row.version.length > 80)
  )
    throw Error('DESKTOP_REQUEST_INVALID');
  if (
    ['browser', 'preview'].includes(row.type) &&
    typeof row.enabled !== 'boolean'
  )
    throw Error('DESKTOP_REQUEST_INVALID');
  const allowed = ['v', 'id', 'type', ...keys[row.type]!];
  if (
    Object.keys(row).length !== allowed.length ||
    Object.keys(row).some((key) => !allowed.includes(key))
  )
    throw Error('DESKTOP_REQUEST_INVALID');
  const text = (key: string, maximum: number) =>
    typeof row[key] === 'string' &&
    (row[key] as string).length > 0 &&
    (row[key] as string).length <= maximum &&
    !hasControl(row[key] as string);
  if (row.type === 'pair') {
    if (!text('server', 2048) || !text('code', 32))
      throw Error('DESKTOP_REQUEST_INVALID');
    const url = new URL(row.server as string);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    )
      throw Error('DESKTOP_SERVER_INVALID');
    if (!/^[a-f0-9]{4}-?[a-f0-9]{4}$/i.test((row.code as string).trim()))
      throw Error('DESKTOP_PAIRING_CODE_INVALID');
  }
  if (row.type === 'workspace' || row.type === 'picker') {
    if (
      !(row.type === 'picker' && row.path === null) &&
      (!text('path', 4096) || !(row.path as string).startsWith('/'))
    )
      throw Error('DESKTOP_PATH_INVALID');
    if (
      row.type === 'picker' &&
      (!text('pickerId', 80) ||
        !/^[a-zA-Z0-9_-]+$/.test(row.pickerId as string))
    )
      throw Error('DESKTOP_REQUEST_INVALID');
  }
  if (
    row.type === 'revoke' &&
    (!text('confirmDeviceId', 36) ||
      !/^[a-f0-9-]{36}$/i.test(row.confirmDeviceId as string))
  )
    throw Error('DESKTOP_REQUEST_INVALID');
  return row as DesktopRequest;
}

export function desktopSafeText(value: string) {
  return [...value]
    .map((character) => (hasControl(character) ? ' ' : character))
    .join('')
    .slice(0, 120);
}

export function desktopSafeError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  const safe = new Set([
    'BRIDGE_ALREADY_RUNNING',
    'DESKTOP_FRAME_LIMIT',
    'DESKTOP_REQUEST_INVALID',
    'DESKTOP_SERVER_INVALID',
    'DESKTOP_PAIRING_CODE_INVALID',
    'DESKTOP_PATH_INVALID',
    'DESKTOP_PAIRING_REQUIRED',
    'DESKTOP_ALREADY_PAIRED',
    'DESKTOP_CREDENTIAL_UNAVAILABLE',
    'DESKTOP_CONFIG_INVALID',
    'DESKTOP_REQUEST_DUPLICATE',
    'DESKTOP_BUSY',
    'DESKTOP_REVOKE_MISMATCH',
    'DESKTOP_PICKER_CANCELED',
    'DESKTOP_STOP_UNCONFIRMED',
    'UPDATE_DRAIN_BROWSER_ACTIVE',
    'UPDATE_DRAIN_UNCONFIRMED',
    'UPDATE_TRUST_UNCONFIGURED',
    'UPDATE_CHECK_REQUIRED',
    'UPDATE_RECOVERY_REQUIRED',
    'UPDATE_HEALTH_MISMATCH',
    'UPDATE_HEALTH_TIMEOUT',
    'UPDATE_HEALTH_UNCONFIRMED',
    'UPDATE_REQUEST_CONSUMED',
    'UPDATE_STOP_UNCONFIRMED',
    'UPDATE_INSTALL_FAILED',
    'UPDATE_HELPER_START_FAILED',
    'UPDATE_STORAGE_REVIEW',
    'UPDATE_NATIVE_APP_REQUIRED',
    'UPDATE_INSTALL_PATH_UNSAFE',
    'UPDATE_STATE_UNSAFE',
    'UPDATE_METADATA_INVALID',
    'UPDATE_METADATA_LIMIT',
    'UPDATE_METADATA_EXPIRED',
    'UPDATE_SIGNATURE_INVALID',
    'UPDATE_PACKAGE_SIGNATURE_INVALID',
    'UPDATE_PACKAGE_INTEGRITY',
    'UPDATE_PUBLISHER_UNKNOWN',
    'UPDATE_PUBLISHER_MISMATCH',
    'UPDATE_OS_INCOMPATIBLE',
    'UPDATE_FORMAT_INCOMPATIBLE',
    'UPDATE_ARCHITECTURE_INVALID',
    'UPDATE_ORIGIN_INVALID',
    'UPDATE_DOWNLOAD_LIMIT',
    'UPDATE_DOWNLOAD_FAILED',
    'UPDATE_APPLE_VERIFICATION_FAILED',
    'JOURNAL_IDENTITY_MISMATCH',
    'JOURNAL_NAMESPACE_INVALID',
    'BRIDGE_WORKSPACE_CONTAINS_STATE',
    'BRIDGE_WORKSPACE_REQUIRED',
    'LOCAL_BROWSER_UNAVAILABLE',
    'LOCAL_BROWSER_SETTINGS_UNSAFE',
    'LOCAL_BROWSER_LAUNCHER_UNAVAILABLE',
    'LOCAL_PREVIEW_SETTINGS_UNSAFE',
    'LOCAL_PREVIEW_REQUIRES_BROWSER_AND_SANDBOX',
    'LOCAL_PREVIEW_RUNNER_UNAVAILABLE',
  ]);
  return safe.has(code) ? code : 'BRIDGE_ACTION_FAILED';
}
