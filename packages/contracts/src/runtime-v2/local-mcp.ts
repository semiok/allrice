import { z } from 'zod';

import { UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import { FrozenMcpToolSchema, McpDiscoveredToolSchema } from '../mcp.ts';
import { isRuntimeRelativePath } from './policy.ts';

/** P17 is a bounded, offline stdio subset, not host process execution. */
export const localMcpLimits = Object.freeze({
  argumentsBytes: 8 * 1024,
  protocolLineBytes: 64 * 1024,
  discoveryBytes: 128 * 1024,
  receiptBytes: 256 * 1024,
  inputBytes: 256 * 1024,
  stderrBytes: 16 * 1024,
  credentialBytes: 4096,
  tools: 32,
  pages: 8,
  protocolMessages: 64,
});

function boundedJson(value: unknown, maximum: number): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= maximum;
  } catch {
    return false;
  }
}
const path = z.string().max(1024).refine(isRuntimeRelativePath);
export const RuntimeLocalMcpSourceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    version: z.string().trim().min(1).max(120),
    entrypoint: path,
    files: z
      .array(z.object({ path, sha256: ChecksumSchema }).strict())
      .min(1)
      .max(64),
    // SHA256 of canonical JSON {name,version,entrypoint,files}; no credentials.
    digest: ChecksumSchema,
  })
  .strict()
  .superRefine((source, context) => {
    const paths = source.files.map((file) => file.path);
    if (
      !paths.includes(source.entrypoint) ||
      new Set(paths).size !== paths.length ||
      paths.some((p) => paths.some((q) => p.startsWith(`${q}/`)))
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid MCP source manifest',
      });
  });
export type RuntimeLocalMcpSource = z.infer<typeof RuntimeLocalMcpSourceSchema>;

export const RuntimeLocalMcpCredentialReferenceSchema = z
  .object({
    id: UuidSchema,
    revision: z.number().int().positive(),
  })
  .strict();
export type RuntimeLocalMcpCredentialReference = z.infer<
  typeof RuntimeLocalMcpCredentialReferenceSchema
>;

const baseArguments = z
  .object({
    connectionId: UuidSchema,
    connectionRevision: z.number().int().positive(),
    deviceId: UuidSchema,
    path: z.union([z.literal('.'), path]),
    source: RuntimeLocalMcpSourceSchema,
    credential: RuntimeLocalMcpCredentialReferenceSchema.nullable(),
    imageDigest: ChecksumSchema,
    isolation: z.literal('local-vm-container-v1'),
    network: z.literal('none'),
    limits: z
      .object({
        timeoutMs: z.number().int().min(500).max(60_000),
        memoryMiB: z.number().int().min(128).max(512),
        cpuMillis: z.number().int().min(100).max(1000),
        pids: z.number().int().min(16).max(64),
      })
      .strict(),
  })
  .strict();
export const RuntimeLocalMcpDiscoverSchema = z
  .object({
    capability: z.literal('local.mcp.discover'),
    arguments: baseArguments,
  })
  .strict();
export const RuntimeLocalMcpCallSchema = z
  .object({
    capability: z.literal('local.mcp.call'),
    arguments: baseArguments
      .extend({
        tool: FrozenMcpToolSchema,
        toolArguments: z
          .record(z.string(), z.unknown())
          .refine(
            (value) => boundedJson(value, localMcpLimits.argumentsBytes),
            'MCP arguments exceed 8 KiB',
          ),
      })
      .strict(),
  })
  .strict()
  .superRefine(({ arguments: input }, context) => {
    if (
      input.tool.connectionId !== input.connectionId ||
      input.tool.connectionRevision !== input.connectionRevision ||
      (input.credential !== null &&
        input.tool.credentialReference !== input.credential.id)
    )
      context.addIssue({
        code: 'custom',
        message: 'MCP frozen connection mismatch',
      });
  });
export const RuntimeLocalMcpPayloadSchema = z.discriminatedUnion('capability', [
  RuntimeLocalMcpDiscoverSchema,
  RuntimeLocalMcpCallSchema,
]);
export type RuntimeLocalMcpDiscover = z.infer<
  typeof RuntimeLocalMcpDiscoverSchema
>;
export type RuntimeLocalMcpCall = z.infer<typeof RuntimeLocalMcpCallSchema>;
export type RuntimeLocalMcpPayload = z.infer<
  typeof RuntimeLocalMcpPayloadSchema
>;

export const RuntimeLocalMcpToolResultSchema = z
  .object({
    content: z
      .array(
        z
          .object({
            type: z.literal('text'),
            text: z.string().max(localMcpLimits.protocolLineBytes),
          })
          .strict(),
      )
      .max(32),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
    isError: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => boundedJson(value, localMcpLimits.protocolLineBytes),
    'MCP result exceeds bound',
  );
export type RuntimeLocalMcpToolResult = z.infer<
  typeof RuntimeLocalMcpToolResultSchema
>;
export const RuntimeLocalMcpPhaseSchema = z.enum([
  'starting',
  'initializing',
  'discovering',
  'ready',
  'calling',
  'completed',
]);
export const RuntimeLocalMcpResultSchema = z
  .object({
    backend: z.literal('local-vm-container-v1'),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    imageDigest: ChecksumSchema,
    phase: RuntimeLocalMcpPhaseSchema,
    reason: z.enum([
      'completed',
      'canceled',
      'lease_lost',
      'timeout',
      'output_limit',
      'protocol_error',
      'schema_changed',
      'process_failed',
      'memory_limit',
      'unknown',
    ]),
    stopConfirmed: z.boolean(),
    callAttempted: z.boolean(),
    resultKnown: z.boolean(),
    tools: z
      .array(McpDiscoveredToolSchema)
      .max(localMcpLimits.tools)
      .optional(),
    toolResult: RuntimeLocalMcpToolResultSchema.optional(),
    stderr: z.string().max(localMcpLimits.stderrBytes),
    truncated: z.boolean(),
    workCopy: z.literal('local_isolated_copy'),
    sourceDirectoryModified: z.literal(false),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      !boundedJson(result, localMcpLimits.receiptBytes) ||
      (result.tools !== undefined &&
        !boundedJson(result.tools, localMcpLimits.discoveryBytes)) ||
      (result.resultKnown &&
        result.tools === undefined &&
        result.toolResult === undefined) ||
      (!result.resultKnown &&
        (result.tools !== undefined || result.toolResult !== undefined)) ||
      (result.toolResult !== undefined && !result.callAttempted)
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid bounded MCP evidence',
      });
  });
export type RuntimeLocalMcpResult = z.infer<typeof RuntimeLocalMcpResultSchema>;
