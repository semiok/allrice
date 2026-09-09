import { createHash, randomUUID } from 'node:crypto';
import {
  RuntimeLocalMcpPayloadSchema,
  type RuntimeLocalMcpPayload,
  type McpDiscoveredTool,
} from '@allrice/contracts';
import {
  localMcpSourceDigest,
  localMcpToolDigest,
} from '../src/local-mcp-protocol.js';
import { testImage } from './toolchain.js';

export const sourceHash = (source: string) =>
  `sha256:${createHash('sha256').update(source).digest('hex')}`;
export const fixtureTool: McpDiscoveredTool = {
  name: 'echo',
  description: 'Synthetic offline echo',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', maxLength: 100 } },
    required: ['text'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
};
export function fixturePayload(
  source = 'console.log("synthetic");',
  call = false,
): RuntimeLocalMcpPayload {
  const sourceFields = {
    name: 'owned-test',
    version: '1.0.0',
    entrypoint: 'server.mjs',
    files: [{ path: 'server.mjs', sha256: sourceHash(source) }],
  };
  const connectionId = randomUUID();
  return RuntimeLocalMcpPayloadSchema.parse({
    capability: call ? 'local.mcp.call' : 'local.mcp.discover',
    arguments: {
      connectionId,
      connectionRevision: 1,
      deviceId: randomUUID(),
      path: '.',
      source: { ...sourceFields, digest: localMcpSourceDigest(sourceFields) },
      credential: null,
      imageDigest: testImage,
      isolation: 'local-vm-container-v1',
      network: 'none',
      limits: { timeoutMs: 10000, memoryMiB: 128, cpuMillis: 500, pids: 32 },
      ...(call
        ? {
            tool: {
              ...fixtureTool,
              connectionId,
              connectionRevision: 1,
              toolRevisionId: randomUUID(),
              digest: localMcpToolDigest(fixtureTool),
              grantRevision: 1,
              risk: 'write',
              credentialReference: 'local:none',
            },
            toolArguments: { text: 'synthetic' },
          }
        : {}),
    },
  });
}

/** This fixture is copied to a disposable VM only. No network or host files. */
export function stdioFixture(
  callBody = "reply(q,{content:[{type:'text',text:q.params.arguments.text}],structuredContent:{value:q.params.arguments.text}})",
  extra = '',
) {
  return `import readline from 'node:readline';
  const reply=(q,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
  ${extra}
  readline.createInterface({input:process.stdin}).on('line',async line=>{
    const q=JSON.parse(line);
    if(q.method==='initialize')reply(q,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'owned-test',version:'1'}});
    else if(q.method==='tools/list')reply(q,{tools:[${JSON.stringify(fixtureTool)}]});
    else if(q.method==='tools/call'){${callBody}}
  });`;
}
