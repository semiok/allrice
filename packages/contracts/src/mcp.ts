import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';
import { ConnectorRiskSchema } from './knowledge.ts';
import { ChecksumSchema } from './runs.ts';

/** P16 intentionally supports the reviewed v1 Streamable HTTP protocol only. */
export const MCP_PROTOCOL_VERSION = '2025-11-25' as const;
export const McpEndpointSchema = z
  .string()
  .url()
  .max(2_000)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid MCP endpoint' });
      return;
    }
    if (
      url.protocol !== 'https:' ||
      (url.port && url.port !== '443') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'MCP requires an HTTPS endpoint without credentials, query or fragment',
      });
  });
export const McpBearerSchema = z
  .string()
  .min(8)
  .max(4_096)
  .regex(/^[\x21-\x7e]+$/);
export const CreateMcpConnectionInputSchema = z
  .object({
    workspaceId: UuidSchema,
    name: z.string().trim().min(1).max(120),
    endpoint: McpEndpointSchema,
    bearerToken: McpBearerSchema,
  })
  .strict();
export const McpDiscoveredToolSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    description: z.string().max(2_000),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .strict();
export type McpDiscoveredTool = z.infer<typeof McpDiscoveredToolSchema>;
export const McpToolSchema = McpDiscoveredToolSchema.extend({
  revisionId: UuidSchema,
  digest: ChecksumSchema,
  available: z.boolean(),
  allowed: z.boolean(),
  grantRevision: z.number().int().positive(),
  risk: ConnectorRiskSchema,
}).strict();
export const McpConnectionSchema = z
  .object({
    id: UuidSchema,
    definitionId: UuidSchema,
    workspaceId: UuidSchema,
    name: z.string(),
    endpoint: McpEndpointSchema,
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    credentialConfigured: z.boolean(),
    credentialReference: z.string(),
    discoveryState: z.enum(['idle', 'queued', 'running', 'ready', 'error']),
    discoveryCode: z.string().nullable(),
    checkedAt: TimestampSchema.nullable(),
    tools: z.array(McpToolSchema).max(128),
  })
  .strict();
export type McpConnection = z.infer<typeof McpConnectionSchema>;
export const McpGrantInputSchema = z
  .object({
    workspaceId: UuidSchema,
    connectionId: UuidSchema,
    revisionId: UuidSchema,
    allowed: z.boolean(),
    risk: ConnectorRiskSchema,
  })
  .strict();
export const FrozenMcpToolSchema = McpDiscoveredToolSchema.extend({
  connectionId: UuidSchema,
  connectionRevision: z.number().int().positive(),
  toolRevisionId: UuidSchema,
  digest: ChecksumSchema,
  grantRevision: z.number().int().positive(),
  risk: ConnectorRiskSchema,
  credentialReference: z.string().min(1).max(255),
}).strict();
export type FrozenMcpTool = z.infer<typeof FrozenMcpToolSchema>;
export const McpCallInputSchema = z
  .object({
    connectionId: UuidSchema,
    tool: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
/** Only trusted Worker ingress constructs this from the persisted Run snapshot. */
export const McpExecutionPayloadSchema = z
  .object({
    capability: z.literal('cloud.mcp.call'),
    tool: FrozenMcpToolSchema,
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
export type McpExecutionPayload = z.infer<typeof McpExecutionPayloadSchema>;
const McpManagementBaseSchema = z.object({
  workspaceId: UuidSchema,
  connectionId: UuidSchema,
});
export const McpManagementMutationSchema = z.discriminatedUnion('action', [
  McpManagementBaseSchema.extend({ action: z.literal('discover') }).strict(),
  McpManagementBaseSchema.extend({ action: z.literal('revoke') }).strict(),
  McpManagementBaseSchema.extend({
    action: z.literal('rotate'),
    bearerToken: McpBearerSchema,
  }).strict(),
  McpGrantInputSchema.extend({ action: z.literal('grant') }).strict(),
]);
export function isMcpInputValidationError(error: unknown) {
  return error instanceof z.ZodError;
}
export const McpScopeSchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    actorId: UuidSchema,
  })
  .strict();
export type McpScope = z.infer<typeof McpScopeSchema>;
export class McpError extends Error {
  constructor(
    public readonly code:
      | 'MCP_DENIED'
      | 'MCP_INVALID_SCHEMA'
      | 'MCP_SOURCE_DENIED'
      | 'MCP_CREDENTIAL_UNAVAILABLE'
      | 'MCP_DISCOVERY_STALE'
      | 'MCP_UNAVAILABLE'
      | 'MCP_LIMIT'
      | 'MCP_UNKNOWN'
      | 'MCP_CANCELED',
  ) {
    super(code);
  }
}
