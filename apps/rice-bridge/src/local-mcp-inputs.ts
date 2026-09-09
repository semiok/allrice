import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import {
  RuntimeLocalMcpPayloadSchema,
  type RuntimeLocalMcpPayload,
} from '@allrice/contracts';
import { readLocalCommandInputs } from './local-command-inputs.js';
import { localMcpCredentialDirectory } from './local-mcp-credentials.js';
import { LocalMcpError, localMcpSourceDigest } from './local-mcp-protocol.js';

/** Stage only a hash-frozen manifest into the existing VM copy. A package is
 * preprepared JS + explicit dependencies; this never downloads or installs it. */
export async function readLocalMcpInputs(
  root: string,
  value: RuntimeLocalMcpPayload,
) {
  try {
    const input = RuntimeLocalMcpPayloadSchema.parse(value);
    const args = input.arguments;
    if (localMcpSourceDigest(args.source) !== args.source.digest)
      throw new LocalMcpError('LOCAL_MCP_SOURCE_CHANGED');
    const canonicalRoot = await realpath(root);
    const credentialDirectory = await localMcpCredentialDirectory();
    const credentialRelative = relative(canonicalRoot, credentialDirectory);
    if (
      credentialRelative === '' ||
      (!credentialRelative.startsWith(`..${sep}`) &&
        credentialRelative !== '..' &&
        !isAbsolute(credentialRelative))
    )
      throw new LocalMcpError('LOCAL_MCP_INPUT_DENIED');
    const prefix = args.path === '.' ? '' : `${args.path}/`;
    const staged = await readLocalCommandInputs(canonicalRoot, {
      capability: 'local.process.execute',
      arguments: {
        executable: '/usr/local/bin/node',
        args: [],
        path: args.path,
        files: args.source.files.map((file) => ({
          path: prefix + file.path,
          sha256: file.sha256,
        })),
        imageDigest: args.imageDigest,
        isolation: args.isolation,
        network: args.network,
        limits: { ...args.limits, outputBytes: 65_536 },
      },
    });
    return { input, files: staged.files };
  } catch (error) {
    if (error instanceof LocalMcpError) throw error;
    throw new LocalMcpError('LOCAL_MCP_INPUT_DENIED');
  }
}
