import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import {
  RuntimeLocalMcpCredentialReferenceSchema,
  type RuntimeLocalMcpCredentialReference,
} from '@allrice/contracts';
import { configPath, readConfig } from './config.js';
import {
  readCredentialRecordFile,
  writeCredentialRecordFile,
} from './credential-files.js';
import { LocalMcpError, localMcpDigest } from './local-mcp-protocol.js';

export interface LocalMcpCredentialBinding {
  server: string;
  deviceId: string;
  connectionId: string;
  sourceDigest: string;
  reference: RuntimeLocalMcpCredentialReference;
}
type RecordValue = LocalMcpCredentialBinding & {
  version: 1;
  storage: 'private-file-unencrypted';
  state: 'active' | 'revoked';
  token?: string;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function binding(input: LocalMcpCredentialBinding): LocalMcpCredentialBinding {
  try {
    const url = new URL(input.server);
    if (
      url.origin !== input.server ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]'].includes(url.hostname)
        )) ||
      !uuid.test(input.deviceId) ||
      !uuid.test(input.connectionId) ||
      !/^sha256:[a-f0-9]{64}$/.test(input.sourceDigest)
    )
      throw Error();
    return {
      server: input.server,
      deviceId: input.deviceId,
      connectionId: input.connectionId,
      sourceDigest: input.sourceDigest,
      reference: RuntimeLocalMcpCredentialReferenceSchema.parse(
        input.reference,
      ),
    };
  } catch {
    throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_MISMATCH');
  }
}
function validToken(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{8,4096}$/.test(value);
}
export async function localMcpCredentialDirectory() {
  const parent = await realpath(dirname(configPath()));
  return join(parent, `${basename(configPath())}.mcp-credentials`);
}
const filename = (value: LocalMcpCredentialBinding) =>
  `${value.reference.id}-${value.reference.revision}.json`;
async function readRecord(
  input: LocalMcpCredentialBinding,
): Promise<RecordValue | null> {
  const expected = binding(input);
  try {
    const directory = await localMcpCredentialDirectory();
    const text = await readCredentialRecordFile(directory, filename(expected));
    if (text === null) return null;
    const record: RecordValue = JSON.parse(text);
    if (
      record.version !== 1 ||
      record.storage !== 'private-file-unencrypted' ||
      !['active', 'revoked'].includes(record.state) ||
      Object.keys(record).some(
        (key) =>
          ![
            'version',
            'storage',
            'state',
            'server',
            'deviceId',
            'connectionId',
            'sourceDigest',
            'reference',
            'token',
          ].includes(key),
      ) ||
      localMcpDigest(binding(record)) !== localMcpDigest(expected) ||
      (record.state === 'active'
        ? !validToken(record.token)
        : Object.hasOwn(record, 'token'))
    )
      throw Error();
    return record;
  } catch {
    throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_UNAVAILABLE');
  }
}
export async function storeLocalMcpCredential(
  input: LocalMcpCredentialBinding,
  token: string,
) {
  const expected = binding(input);
  if (!validToken(token))
    throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_UNAVAILABLE');
  const existing = await readRecord(expected);
  if (existing) {
    if (existing.state === 'active' && existing.token === token) return;
    throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_REVISION_EXISTS');
  }
  try {
    await writeCredentialRecordFile(
      await localMcpCredentialDirectory(),
      filename(expected),
      JSON.stringify({
        version: 1,
        storage: 'private-file-unencrypted',
        state: 'active',
        ...expected,
        token,
      }),
    );
    if ((await readRecord(expected))?.token !== token) throw Error();
  } catch {
    throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_UNAVAILABLE');
  }
}
export async function readLocalMcpCredential(
  input: LocalMcpCredentialBinding,
): Promise<string> {
  const record = await readRecord(input);
  if (!record) throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_UNAVAILABLE');
  if (record.state === 'revoked')
    throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_REVOKED');
  return record.token!;
}
export async function revokeLocalMcpCredential(
  input: LocalMcpCredentialBinding,
) {
  const expected = binding(input);
  // Keep a no-secret tombstone: the same reference/revision cannot be restored
  // by an old set command. This is not a secure erase of filesystem backups.
  await readRecord(expected);
  try {
    await writeCredentialRecordFile(
      await localMcpCredentialDirectory(),
      filename(expected),
      JSON.stringify({
        version: 1,
        storage: 'private-file-unencrypted',
        state: 'revoked',
        ...expected,
      }),
    );
    const record = await readRecord(expected);
    if (record?.state !== 'revoked' || Object.hasOwn(record, 'token'))
      throw Error();
  } catch {
    throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_UNAVAILABLE');
  }
  return {
    localCredentialRevoked: true,
    cloudConnectionRevoked: false,
    storage: 'private-file-unencrypted' as const,
  };
}

async function boundedCredentialStdin(): Promise<string> {
  if (process.stdin.isTTY)
    throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_UNAVAILABLE');
  return new Promise((resolve, reject) => {
    let text = '';
    const fail = () => {
      cleanup();
      reject(new LocalMcpError('LOCAL_MCP_CREDENTIAL_UNAVAILABLE'));
    };
    const data = (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (Buffer.byteLength(text) > 4098) fail();
    };
    const end = () => {
      cleanup();
      const token = text.replace(/\r?\n$/, '');
      if (validToken(token)) resolve(token);
      else reject(new LocalMcpError('LOCAL_MCP_CREDENTIAL_UNAVAILABLE'));
    };
    const timer = setTimeout(fail, 10000);
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', data);
      process.stdin.off('end', end);
      process.stdin.off('error', fail);
      process.stdin.pause();
    };
    process.stdin.on('data', data);
    process.stdin.once('end', end);
    process.stdin.once('error', fail);
  });
}
/** Explicit local operator command. Secret arrives only on stdin, never argv.
 * The outer CLI instance lock excludes a concurrently running Bridge. */
export function localMcpCredentialHelp() {
  console.info(`Rice Bridge 本地 MCP 凭证（受保护但未加密，非 Keychain）
  local-mcp status|enable|disable
  local-mcp credential set <connectionId> <sourceDigest> <refId> <revision> --private-file-unencrypted
  local-mcp credential revoke <connectionId> <sourceDigest> <refId> <revision> --private-file-unencrypted

enable 必须先完成 sandbox enable，不自动安装或开启沙箱；设置绑定设备和配对。
先正常退出 Bridge；set 只从非交互式 stdin 读取凭证，不接受 argv 或终端直接输入。
同一 ref/revision 不允许轮换；撤销保留无密钥 tombstone，新凭证须使用新 revision。
本地凭证配置不授权工具执行，本地 revoke 不等于云端连接撤销。
云端撤销会使运行中的短租约失效；本地配置完成后再启动 Bridge。`);
}
export async function localMcpCredentialCli(args: string[]) {
  try {
    await runCredentialCli(args);
  } catch (error) {
    if (error instanceof LocalMcpError) throw error;
    throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_UNAVAILABLE');
  }
}
async function runCredentialCli(args: string[]) {
  const [
    noun,
    action,
    connectionId,
    sourceDigest,
    id,
    revision,
    acknowledgement,
    ...extra
  ] = args;
  if (
    noun !== 'credential' ||
    !['set', 'revoke'].includes(action ?? '') ||
    extra.length ||
    acknowledgement !== '--private-file-unencrypted' ||
    !/^[1-9][0-9]*$/.test(revision ?? '')
  )
    throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_MISMATCH');
  const configMetadata = await lstat(configPath());
  if (
    !configMetadata.isFile() ||
    configMetadata.isSymbolicLink() ||
    configMetadata.nlink !== 1 ||
    configMetadata.uid !== process.getuid?.() ||
    (configMetadata.mode & 0o077) !== 0
  )
    throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_UNAVAILABLE');
  const config = await readConfig();
  if (!config) throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_UNAVAILABLE');
  const input = binding({
    server: new URL(config.server).origin,
    deviceId: config.deviceId,
    connectionId: connectionId!,
    sourceDigest: sourceDigest!,
    reference: { id: id!, revision: Number(revision) },
  });
  if (action === 'set') {
    await storeLocalMcpCredential(input, await boundedCredentialStdin());
    console.info(
      JSON.stringify({
        stored: true,
        storage: 'private-file-unencrypted',
        reference: input.reference,
        warning:
          '受保护但未加密的本机私有文件；非 Keychain，不授权云端连接或工具调用',
      }),
    );
  } else console.info(JSON.stringify(await revokeLocalMcpCredential(input)));
}
