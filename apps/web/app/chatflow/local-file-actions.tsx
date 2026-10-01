'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  LocalFileResult,
  LocalFileVersion,
  WorkbenchArtifact,
} from '@allrice/contracts';
import { DshDialog } from './dsh-upstream/Dialog';
import { readJson } from './chatflow-utils';
import type { BridgeDevice } from './chatflow-types';
import styles from './local-file-actions.module.css';

export type LocalFileCommandView = {
  id: string;
  status: string;
  summary: string | null;
  errorCode: string | null;
  cancelRequested: boolean;
  deviceId: string;
  folderGrantId: string;
  output: LocalFileResult | null;
};
export const localFileStatus = (command: LocalFileCommandView) => {
  if (command.status === 'succeeded')
    return command.output?.status === 'saved'
      ? '已保存到电脑，原始字节校验一致。'
      : command.output?.status === 'uploaded'
        ? '已上传，平台原始文件可下载。'
        : command.output?.status === 'inspected'
          ? '当前电脑文件版本已核验。'
          : command.output?.status === 'opened'
            ? '电脑已用默认应用接收打开请求。'
            : 'Finder 已接收定位请求。';
  if (command.status === 'unknown')
    return '结果待核实；不会自动重做。可核验当前文件，或到电脑上检查。';
  if (command.status === 'canceled') return '已取消，未提交文件。';
  if (command.status === 'expired') return '设备未在时限内接收，文件未处理。';
  if (command.status === 'failed')
    return (
      (
        {
          PATH_ALREADY_EXISTS: '同名文件已存在，请改名后另存；未覆盖。',
          FILE_CHANGED: '文件版本已变化，请重新选择并核验。',
          DEFAULT_APPLICATION_UNAVAILABLE: '电脑没有可用的默认打开应用。',
          FOLDER_CHANGED: '目录已变化，请重新选择授权目录。',
          FILE_TOO_LARGE: '文件超过 9 MB 上限。',
          LOCAL_FILE_FAILED:
            '文件已移动、无权访问或目录不可用，请到电脑上检查。',
        } as Record<string, string>
      )[command.errorCode ?? ''] ??
      '本机未完成文件操作，请检查目录、版本或连接。'
    );
  return command.cancelRequested
    ? '已请求取消，等待电脑确认。'
    : command.status === 'queued'
      ? '等待电脑接收…'
      : '电脑正在处理…';
};
export async function waitLocalFileCommand(
  command: LocalFileCommandView,
  workspaceId: string,
  headers: Record<string, string>,
  onProgress?: (value: LocalFileCommandView) => void,
  signal?: AbortSignal,
) {
  let current = command;
  for (let count = 0; count < 610; count++) {
    onProgress?.(current);
    if (!['queued', 'claimed', 'running'].includes(current.status))
      return current;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      };
      const timer = setTimeout(done, 500),
        cancel = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          reject(Error('FILE_VIEW_CLOSED'));
        };
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
    current = await readJson<LocalFileCommandView>(
      await fetch(
        `/api/v1/bridge/files/${command.id}?workspaceId=${workspaceId}`,
        { headers, signal, cache: 'no-store' },
      ),
    );
  }
  throw Error('电脑结果仍在对账，请稍后查看。');
}

export function LocalArtifactFileDialog({
  artifact,
  onClose,
}: {
  artifact: WorkbenchArtifact;
  onClose: () => void;
}) {
  const headers = {
    'x-allrice-organization-id': artifact.object.organizationId,
    'x-allrice-workspace-id': artifact.object.workspaceId,
  };
  const [devices, setDevices] = useState<BridgeDevice[]>([]),
    [deviceId, setDeviceId] = useState(''),
    [grantId, setGrantId] = useState('');
  const [path, setPath] = useState(artifact.version.fileName),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [command, setCommand] = useState<LocalFileCommandView | null>(null),
    [saved, setSaved] = useState<{
      path: string;
      file: LocalFileVersion;
    } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const actionKeys = useRef(new Map<string, string>());
  useEffect(() => {
    const abort = new AbortController();
    void fetch(
      `/api/v1/bridge/devices?workspaceId=${artifact.object.workspaceId}`,
      { headers, signal: abort.signal, cache: 'no-store' },
    )
      .then((r) => readJson<{ devices: BridgeDevice[] }>(r))
      .then(({ devices: all }) => {
        const eligible = all.filter(
          (d) =>
            d.status === 'online' &&
            d.folderGrants.length &&
            d.readiness?.some(
              (r) =>
                r.capability === 'local.file.save' &&
                ['ready', 'busy', 'preparing'].includes(r.state),
            ),
        );
        setDevices(eligible);
        setDeviceId(eligible[0]?.id ?? '');
        setGrantId(eligible[0]?.folderGrants.at(-1)?.id ?? '');
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError('连接支持文件交接的 Mac，并先选择目录。');
      });
    return () => {
      abort.abort();
      controller.current?.abort();
    };
  }, [artifact.id]);
  async function action(kind: 'save' | 'open' | 'reveal' | 'inspect') {
    if (busy) return;
    setBusy(true);
    setError('');
    const abort = new AbortController();
    controller.current = abort;
    try {
      const key = JSON.stringify([
        kind,
        deviceId,
        grantId,
        path,
        kind === 'open' || kind === 'reveal'
          ? saved?.file
          : artifact.object.checksum,
      ]);
      if (!actionKeys.current.has(key))
        actionKeys.current.set(key, crypto.randomUUID());
      const next = await readJson<LocalFileCommandView>(
        await fetch('/api/v1/bridge/files', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          signal: abort.signal,
          body: JSON.stringify({
            workspaceId: artifact.object.workspaceId,
            deviceId,
            folderGrantId: grantId,
            idempotencyKey: actionKeys.current.get(key),
            action: kind,
            path,
            ...(kind === 'save'
              ? {
                  objectId: artifact.object.id,
                  checksum: artifact.object.checksum,
                }
              : kind === 'inspect'
                ? {}
                : { expected: saved?.file }),
          }),
        }),
      );
      const terminal = await waitLocalFileCommand(
        next,
        artifact.object.workspaceId,
        headers,
        setCommand,
        abort.signal,
      );
      if (
        terminal.status !== 'unknown' &&
        !(kind === 'save' && terminal.status === 'succeeded')
      )
        actionKeys.current.delete(key);
      if (
        terminal.output &&
        ['saved', 'inspected'].includes(terminal.output.status)
      ) {
        if (
          terminal.output.file.checksum === artifact.object.checksum &&
          terminal.output.file.sizeBytes === artifact.object.sizeBytes
        )
          setSaved({ path: terminal.output.path, file: terminal.output.file });
        else {
          setSaved(null);
          setError('当前文件与平台成果字节不同，不视为已保存此版本。');
        }
      }
    } catch (e) {
      if (!abort.signal.aborted)
        setError(e instanceof Error ? e.message : '文件操作暂不可用');
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  const device = devices.find((d) => d.id === deviceId);
  return (
    <DshDialog
      ariaLabel={`${artifact.version.fileName} 保存到电脑`}
      title="保存到电脑"
      eyebrow={`原始文件 · v${artifact.version.version}`}
      onClose={onClose}
    >
      <div className={styles.body}>
        <p>
          原始文件已可在平台下载。下方状态只说明所选 Mac
          的实际保存或系统打开结果。
        </p>
        <label>
          电脑
          <select
            disabled={busy}
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value);
              setGrantId(
                devices
                  .find((d) => d.id === e.target.value)
                  ?.folderGrants.at(-1)?.id ?? '',
              );
              setSaved(null);
              setCommand(null);
            }}
          >
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          已授权目录
          <select
            disabled={busy}
            value={grantId}
            onChange={(e) => {
              setGrantId(e.target.value);
              setSaved(null);
              setCommand(null);
            }}
          >
            {device?.folderGrants.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        {!devices.length && <p>请在“我的电脑”连接新版 Bridge 并选择目录。</p>}
        <label>
          目录内文件名
          <input
            value={path}
            disabled={busy}
            onChange={(e) => {
              setPath(e.target.value);
              setSaved(null);
              setCommand(null);
            }}
          />
        </label>
        <small>最多 9 MB；已有同名文件不会覆盖。目录变化后需重新选择。</small>
        <div className={styles.actions}>
          <button
            type="button"
            disabled={busy || !grantId}
            onClick={() => void action('save')}
          >
            保存原始文件
          </button>
          <button
            type="button"
            disabled={busy || !saved || saved.path !== path}
            onClick={() => void action('reveal')}
          >
            在 Finder 定位
          </button>
          <button
            type="button"
            disabled={busy || !saved || saved.path !== path}
            onClick={() => void action('open')}
          >
            用默认应用打开
          </button>
          <button
            type="button"
            disabled={busy || !grantId}
            onClick={() => void action('inspect')}
          >
            核验已有文件
          </button>
          {busy && command && (
            <button
              type="button"
              onClick={() =>
                void fetch(
                  `/api/v1/bridge/files/${command.id}?workspaceId=${artifact.object.workspaceId}`,
                  { method: 'POST', headers },
                )
                  .then((r) => readJson<LocalFileCommandView>(r))
                  .then(setCommand)
                  .catch(() => setError('取消请求未确认，请检查连接。'))
              }
            >
              取消
            </button>
          )}
        </div>
        {command && <p role="status">{localFileStatus(command)}</p>}
        {saved &&
          command?.output?.status === 'inspected' &&
          saved.file.checksum !== artifact.object.checksum && (
            <p>当前文件与平台成果的字节不同，不视为已保存此版本。</p>
          )}
        {error && <p role="alert">{error}</p>}
      </div>
    </DshDialog>
  );
}
