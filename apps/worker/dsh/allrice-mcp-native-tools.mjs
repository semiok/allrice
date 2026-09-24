import { z } from 'zod';

// DSH's DSL describes shape only; repeat bounds before JSON-RPC. The Broker
// independently validates exact frozen tenant/employee grants and approvals.
const McpCallSchema = z
  .object({
    connectionId: z.uuid(),
    tool: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
export const McpNativeArgumentsSchema = z.union([
  McpCallSchema,
  z
    .object({
      action: z.literal('connect'),
      name: z.string().trim().min(1).max(120),
      endpoint: z.url().max(2000),
    })
    .strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('status'), connectionId: z.uuid() }).strict(),
]);
export const mcpNativeTools = [
  {
    canonicalName: 'cloud.mcp.call',
    wireName: 'cloud_mcp_call',
    description:
      'Connect applications and call their tools. action=connect with name/endpoint discovers an application; action=list lists connected apps; action=status with connectionId refreshes status. Public services need no credentials. Login happens only in the dedicated form; NEVER request secrets in chat. Call with connectionId/tool/arguments from the returned catalog; connections work in this task without republishing. Exact action approval still applies; never replay unknown effects.',
    parameters: {
      action: {
        type: 'string',
        enum: ['connect', 'list', 'status'],
        description: 'Omit to execute a tool.',
      },
      name: {
        type: 'string',
        description: 'Human-readable application name for connect.',
      },
      endpoint: {
        type: 'string',
        description: 'Public HTTPS MCP endpoint, without embedded credentials.',
      },
      connectionId: {
        type: 'string',
        description: 'Connection UUID from the current application catalog.',
      },
      tool: {
        type: 'string',
        description:
          'Exact tool name from the returned application catalog; at most 128 ASCII letters/digits/dot/underscore/hyphen.',
      },
      arguments: {
        type: 'object',
        additionalProperties: true,
        description:
          'Arguments matching the exact frozen remote input schema; never include credentials.',
      },
    },
    timeoutMs: 180000,
    isConcurrencySafe: false,
    validateArguments(args) {
      McpNativeArgumentsSchema.parse(args);
      return args;
    },
  },
];
