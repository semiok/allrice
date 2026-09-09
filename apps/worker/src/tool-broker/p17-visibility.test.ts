import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LocalMcpSnapshotSchema,
  type SkillCapability,
} from '@allrice/contracts';
import {
  riceToolDefinitionsForCapabilities,
  riceReadOnlyToolDefinitionsForPreview,
} from './definitions.js';
import { validateLocalMcpInput } from './handlers/local-mcp.js';

const connectionId = randomUUID(),
  employeeAuthorization = {
    id: randomUUID(),
    revision: 1,
    employeeId: randomUUID(),
    employeeVersionId: randomUUID(),
  };
const snapshot = LocalMcpSnapshotSchema.parse({
  connections: [
    {
      connectionId,
      connectionRevision: 1,
      deviceId: randomUUID(),
      folderGrantId: randomUUID(),
      folderGrantVersion: 1,
      employeeAuthorization,
      configuration: {
        path: '.',
        credential: null,
        source: {
          name: 'synthetic',
          version: '1',
          entrypoint: 'server.mjs',
          files: [{ path: 'server.mjs', sha256: `sha256:${'a'.repeat(64)}` }],
          digest: `sha256:${'b'.repeat(64)}`,
        },
      },
    },
  ],
  tools: [
    {
      connectionId,
      connectionRevision: 1,
      name: 'echo',
      description: 'Synthetic',
      inputSchema: { type: 'object' },
      outputSchema: null,
      toolRevisionId: randomUUID(),
      digest: `sha256:${'c'.repeat(64)}`,
      grantRevision: 1,
      risk: 'write',
      credentialReference: `local-mcp:${connectionId}:none`,
      employeeAuthorization,
    },
  ],
});
const local = ['local.mcp.discover', 'local.mcp.call'];
const capabilities: SkillCapability[] = ['secret:use', 'storage:write'];
const flags = [
  'ALLRICE_LOCAL_MCP_ENABLED',
  'ALLRICE_LOCAL_COMMAND_ENABLED',
  'ALLRICE_RUNTIME_POLICY_ENABLED',
  'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
];
const enable = () => flags.forEach((flag) => vi.stubEnv(flag, '1'));
const names = (tools: { name: string }[]) =>
  tools.map((t) => t.name).filter((name) => local.includes(name));
afterEach(() => vi.unstubAllEnvs());

it('rejects invalid local tool arguments before creating an approval or starting server code', () => {
  const catalog = {
    ...snapshot,
    tools: snapshot.tools.map((t) => ({
      ...t,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    })),
  };
  const args = { connectionId, tool: 'echo', arguments: {} };
  expect(validateLocalMcpInput('local.mcp.call', args, catalog)).toEqual(args);
  expect(() =>
    validateLocalMcpInput(
      'local.mcp.call',
      { ...args, arguments: { unexpected: true } },
      catalog,
    ),
  ).toThrow('MCP_INVALID_SCHEMA');
  expect(() =>
    validateLocalMcpInput(
      'local.mcp.call',
      { ...args, arguments: { large: 'x'.repeat(8193) } },
      catalog,
    ),
  ).toThrow('MCP_LIMIT');
  expect(() =>
    validateLocalMcpInput('local.mcp.call', args, { ...catalog, tools: [] }),
  ).toThrow('MCP_DENIED');
  expect(() =>
    validateLocalMcpInput(
      'local.mcp.discover',
      { connectionId, command: 'forged' },
      catalog,
    ),
  ).toThrow();
});

it('keeps cloud grants separate from local grants even when all local flags are enabled', () => {
  enable();
  expect(
    names(
      riceToolDefinitionsForCapabilities(capabilities, local, snapshot.tools),
    ),
  ).toEqual([]);
  expect(
    names(
      riceToolDefinitionsForCapabilities(
        capabilities,
        ['cloud.mcp.call'],
        [],
        snapshot,
      ),
    ),
  ).toEqual([]);
  expect(
    names(
      riceToolDefinitionsForCapabilities(capabilities, undefined, [], snapshot),
    ),
  ).toEqual([]);
  expect(
    names(
      riceToolDefinitionsForCapabilities(capabilities, local, [], snapshot),
    ),
  ).toEqual(local);
  expect(
    names(riceReadOnlyToolDefinitionsForPreview(capabilities, local)),
  ).toEqual([]);
});
it.each(flags)('requires the independent %s flag', (flag) => {
  enable();
  vi.stubEnv(flag, '0');
  expect(
    names(
      riceToolDefinitionsForCapabilities(capabilities, local, [], snapshot),
    ),
  ).toEqual([]);
});
it.each(capabilities)(
  'requires %s independently of configuration and manifest',
  (missing) => {
    enable();
    expect(
      names(
        riceToolDefinitionsForCapabilities(
          capabilities.filter((c) => c !== missing),
          local,
          [],
          snapshot,
        ),
      ),
    ).toEqual([]);
  },
);
it('discovery alone exposes no tool call and never accepts a cloud tool as a local frozen connection', () => {
  enable();
  expect(
    names(
      riceToolDefinitionsForCapabilities(capabilities, local, [], {
        ...snapshot,
        tools: [],
      }),
    ),
  ).toEqual(['local.mcp.discover']);
  expect(
    LocalMcpSnapshotSchema.safeParse({ ...snapshot, connections: [] }).success,
  ).toBe(false);
  expect(
    LocalMcpSnapshotSchema.safeParse({
      ...snapshot,
      tools: [{ ...snapshot.tools[0], credentialReference: 'cloud:secret' }],
    }).success,
  ).toBe(false);
  expect(
    LocalMcpSnapshotSchema.safeParse({
      ...snapshot,
      tools: [snapshot.tools[0], snapshot.tools[0]],
    }).success,
  ).toBe(false);
});
