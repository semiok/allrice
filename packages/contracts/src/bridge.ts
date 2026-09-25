import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';

export const BridgeProtocolVersion = 2 as const;

export const BridgeProtocolVersionSchema = z.union([
  z.literal(1),
  z.literal(2),
]);

export const BridgePlatformSchema = z.enum(['macos-arm64', 'macos-x64']);
export type BridgePlatform = z.infer<typeof BridgePlatformSchema>;

export const BridgeCapabilitySchema = z.enum([
  'local.fs.list',
  'local.fs.search',
  'local.fs.read',
  'local.fs.write',
  'local.fs.mkdir',
  'local.git.status',
  'local.git.diff',
]);
export type BridgeCapability = z.infer<typeof BridgeCapabilitySchema>;

export const BridgeCapabilities = BridgeCapabilitySchema.options;

export const BridgeControlInputSchema = z
  .object({
    action: z.enum(['start', 'stop']),
  })
  .strict();
export type BridgeControlInput = z.infer<typeof BridgeControlInputSchema>;

const RelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((path) => !path.startsWith('/') && !path.includes('\\'), {
    message: 'bridge paths must be POSIX-style relative paths',
  })
  .refine((path) => !path.split('/').includes('..'), {
    message: 'bridge paths cannot traverse parent directories',
  });

export const BridgeCommandPayloadSchema = z.discriminatedUnion('capability', [
  z
    .object({
      capability: z.literal('local.fs.list'),
      arguments: z
        .object({
          path: RelativePathSchema.default('.'),
          limit: z.number().int().min(1).max(200).default(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal('local.fs.search'),
      arguments: z
        .object({
          path: RelativePathSchema.default('.'),
          query: z.string().trim().min(1).max(500),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal('local.fs.read'),
      arguments: z
        .object({
          path: RelativePathSchema,
          maxBytes: z.number().int().min(1).max(200_000).default(200_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal('local.fs.write'),
      arguments: z
        .object({
          path: RelativePathSchema,
          content: z.string().max(200_000),
          expectedSha256: z
            .string()
            .regex(/^sha256:[a-f0-9]{64}$/)
            .nullable()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal('local.fs.mkdir'),
      arguments: z.object({ path: RelativePathSchema }).strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal('local.git.status'),
      arguments: z.object({ path: RelativePathSchema.default('.') }).strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal('local.git.diff'),
      arguments: z
        .object({
          path: RelativePathSchema.default('.'),
          staged: z.boolean().default(false),
          maxBytes: z.number().int().min(1).max(200_000).default(200_000),
        })
        .strict(),
    })
    .strict(),
]);
export type BridgeCommandPayload = z.infer<typeof BridgeCommandPayloadSchema>;

export const BridgeDeviceStatusSchema = z.enum([
  'online',
  'offline',
  'revoked',
]);

export const BridgeDeviceSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    name: z.string().trim().min(1).max(120),
    platform: BridgePlatformSchema,
    protocolVersion: BridgeProtocolVersionSchema,
    capabilities: z.array(BridgeCapabilitySchema).min(1).max(16),
    status: BridgeDeviceStatusSchema,
    lastSeenAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    revokedAt: TimestampSchema.nullable(),
  })
  .strict();
export type BridgeDevice = z.infer<typeof BridgeDeviceSchema>;

export const CreateBridgePairingInputSchema = z
  .object({
    workspaceId: UuidSchema,
    deviceName: z.string().trim().min(1).max(120),
  })
  .strict();

export const BridgePairingSchema = z
  .object({
    id: UuidSchema,
    code: z.string().regex(/^[A-F0-9]{4}-[A-F0-9]{4}$/),
    deviceName: z.string().trim().min(1).max(120),
    expiresAt: TimestampSchema,
  })
  .strict();

export const PairBridgeDeviceInputSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Fa-f0-9]{4}-?[A-Fa-f0-9]{4}$/),
    name: z.string().trim().min(1).max(120),
    platform: BridgePlatformSchema,
    protocolVersion: z.literal(BridgeProtocolVersion),
    capabilities: z.array(BridgeCapabilitySchema).min(1).max(16),
  })
  .strict();

export const PairBridgeDeviceResponseSchema = z
  .object({
    device: BridgeDeviceSchema,
    deviceToken: z.string().min(32).max(256),
  })
  .strict();

export const BridgeSettingsSchema = z
  .object({
    localCommand: z.boolean(),
    localBrowser: z.boolean(),
    development: z.boolean(),
  })
  .strict();
export type BridgeSettings = z.infer<typeof BridgeSettingsSchema>;
export const BridgeSettingsCommandSchema = z
  .object({
    revision: z.number().int().positive(),
    settings: BridgeSettingsSchema,
  })
  .strict();
export type BridgeSettingsCommand = z.infer<typeof BridgeSettingsCommandSchema>;
export const UpdateBridgeSettingsSchema = z
  .object({
    capability: z.enum(['localCommand', 'localBrowser', 'development']),
    enabled: z.boolean(),
  })
  .strict();

/** Optional on protocol v2: old clients never advertise default browser access. */
export const BridgeEnvironmentSchema = z
  .object({
    version: z.literal(1),
    clientVersion: z.string().max(80),
    browser: z.enum(['preparing', 'ready', 'paused', 'unavailable']),
    sandbox: z.enum(['preparing', 'ready', 'paused', 'unavailable']),
    preview: z.enum(['preparing', 'ready', 'paused', 'unavailable']),
    paused: z.boolean(),
    settings: BridgeSettingsSchema.optional(),
    settingsRevision: z.number().int().nonnegative().optional(),
    development: z
      .enum(['preparing', 'ready', 'paused', 'unavailable'])
      .optional(),
  })
  .strict();
export type BridgeEnvironment = z.infer<typeof BridgeEnvironmentSchema>;

export const HeartbeatBridgeDeviceInputSchema = z
  .object({
    protocolVersion: z.literal(BridgeProtocolVersion),
    capabilities: z.array(BridgeCapabilitySchema).min(1).max(16),
    environment: BridgeEnvironmentSchema.optional(),
  })
  .strict();

export const CreateBridgeFolderGrantInputSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    rootFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const BridgeFolderGrantSchema = z
  .object({
    id: UuidSchema,
    deviceId: UuidSchema,
    label: z.string().min(1).max(120),
    rootFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: TimestampSchema,
    revokedAt: TimestampSchema.nullable(),
  })
  .strict();
export type BridgeFolderGrant = z.infer<typeof BridgeFolderGrantSchema>;

export const BridgeWorkspaceSelectionStatusSchema = z.enum([
  'queued',
  'claimed',
  'succeeded',
  'failed',
  'canceled',
]);

export const BridgeWorkspaceSelectionRequestSchema = z
  .object({
    id: UuidSchema,
    deviceId: UuidSchema,
    status: BridgeWorkspaceSelectionStatusSchema,
    leaseToken: UuidSchema,
    requestedAt: TimestampSchema,
  })
  .strict();
export type BridgeWorkspaceSelectionRequest = z.infer<
  typeof BridgeWorkspaceSelectionRequestSchema
>;

export const CompleteBridgeWorkspaceSelectionInputSchema = z
  .object({
    leaseToken: UuidSchema,
    status: z.enum(['succeeded', 'failed']),
    grantId: UuidSchema.optional(),
    errorCode: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'succeeded' && !value.grantId) {
      context.addIssue({
        code: 'custom',
        path: ['grantId'],
        message: 'successful workspace selection requires a folder grant',
      });
    }
    if (value.status === 'failed' && !value.errorCode) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'failed workspace selection requires an error code',
      });
    }
  });

export const BridgeCommandStatusSchema = z.enum([
  'queued',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'expired',
  'canceled',
]);
export type BridgeCommandStatus = z.infer<typeof BridgeCommandStatusSchema>;

export const BridgeCommandSchema = z
  .object({
    id: UuidSchema,
    deviceId: UuidSchema,
    folderGrantId: UuidSchema,
    status: BridgeCommandStatusSchema,
    payload: BridgeCommandPayloadSchema,
    leaseToken: UuidSchema,
    createdAt: TimestampSchema,
    timeoutAt: TimestampSchema,
  })
  .strict();
export type BridgeCommand = z.infer<typeof BridgeCommandSchema>;

export const CompleteBridgeCommandInputSchema = z
  .object({
    leaseToken: UuidSchema,
    status: z.enum(['succeeded', 'failed']),
    output: z.unknown().optional(),
    summary: z.string().trim().min(1).max(500),
    errorCode: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'failed' && !value.errorCode) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'failed bridge commands require an error code',
      });
    }
  });
