import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import {
  McpEmployeeAuthorizationSchema,
  McpToolSchema,
  FrozenMcpToolSchema,
  McpGrantInputSchema,
  McpEmployeeBindingInputSchema,
} from './mcp.ts';
import {
  RuntimeLocalMcpSourceSchema,
  RuntimeLocalMcpCredentialReferenceSchema,
} from './runtime-v2/local-mcp.ts';
import { isRuntimeRelativePath } from './runtime-v2/policy.ts';
import { runtimeContractEqual } from './runtime-v2/identity.ts';

export const LocalMcpConfigurationSchema = z
  .object({
    path: z.union([
      z.literal('.'),
      z.string().max(1024).refine(isRuntimeRelativePath),
    ]),
    source: RuntimeLocalMcpSourceSchema,
    credential: RuntimeLocalMcpCredentialReferenceSchema.nullable(),
  })
  .strict();
export const CreateLocalMcpConnectionSchema = z
  .object({
    workspaceId: UuidSchema,
    name: z.string().trim().min(1).max(120),
    deviceId: UuidSchema,
    folderGrantId: UuidSchema,
    configuration: LocalMcpConfigurationSchema,
  })
  .strict();
export const FrozenLocalMcpConnectionSchema = z
  .object({
    connectionId: UuidSchema,
    connectionRevision: z.number().int().positive(),
    deviceId: UuidSchema,
    folderGrantId: UuidSchema,
    folderGrantVersion: z.number().int().positive(),
    configuration: LocalMcpConfigurationSchema,
    employeeAuthorization: McpEmployeeAuthorizationSchema,
  })
  .strict();
export const LocalMcpConnectionSchema = z
  .object({
    id: UuidSchema,
    name: z.string(),
    workspaceId: UuidSchema,
    deviceId: UuidSchema,
    deviceName: z.string(),
    folderGrantId: UuidSchema,
    folderGrantVersion: z.number().int().positive(),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    configuration: LocalMcpConfigurationSchema,
    discoveryState: z.enum(['idle', 'queued', 'running', 'ready', 'error']),
    checkedAt: TimestampSchema.nullable(),
    // Reference configured does not claim the local secret exists or is usable.
    credentialStorage: z.literal('device_only'),
    tools: z.array(McpToolSchema).max(32),
  })
  .strict();
export const LocalMcpSnapshotSchema = z
  .object({
    connections: z.array(FrozenLocalMcpConnectionSchema).max(16),
    tools: z.array(FrozenMcpToolSchema).max(128),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const connections = new Map(
      snapshot.connections.map((c) => [c.connectionId, c]),
    );
    if (connections.size !== snapshot.connections.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate local MCP connection',
      });
    const tools = new Set<string>();
    snapshot.tools.forEach((tool, index) => {
      const connection = connections.get(tool.connectionId),
        key = `${tool.connectionId}:${tool.name}`;
      if (
        !connection ||
        tool.connectionRevision !== connection.connectionRevision ||
        !runtimeContractEqual(
          tool.employeeAuthorization,
          connection.employeeAuthorization,
        ) ||
        tool.credentialReference !==
          (connection.configuration.credential?.id ??
            `local-mcp:${connection.connectionId}:none`) ||
        tools.has(key)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', index],
          message:
            'Local MCP tool must match its exact frozen device connection',
        });
      }
      tools.add(key);
    });
  });
export const LocalMcpDiscoverInputSchema = z
  .object({ connectionId: UuidSchema })
  .strict();
export const LocalMcpMutationSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('revoke'),
      workspaceId: UuidSchema,
      connectionId: UuidSchema,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal('replace'),
      workspaceId: UuidSchema,
      connectionId: UuidSchema,
      expectedRevision: z.number().int().positive(),
      configuration: LocalMcpConfigurationSchema,
    })
    .strict(),
  McpGrantInputSchema.extend({ action: z.literal('grant') }),
  McpEmployeeBindingInputSchema.extend({
    action: z.literal('employee_binding'),
  }),
]);
export type FrozenLocalMcpConnection = z.infer<
  typeof FrozenLocalMcpConnectionSchema
>;
export type LocalMcpConnection = z.infer<typeof LocalMcpConnectionSchema>;
export type LocalMcpSnapshot = z.infer<typeof LocalMcpSnapshotSchema>;
