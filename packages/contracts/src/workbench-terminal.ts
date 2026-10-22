import { z } from 'zod';
import { UuidSchema } from './common.ts';

/** Human terminals use the pinned DSH protocol. These envelopes only carry it
 * between the authenticated browser and its paired Bridge, never an Agent. */
export const workbenchTerminalSocketPath = '/api/v1/workbench-terminal/socket';
export const workbenchTerminalProtocol = 'allrice.terminal.v1';
export const terminalMaximumScreenBytes = 2 * 1024 * 1024;
export const terminalMaximumPending = 24;
export const TerminalIdSchema = z.string().regex(/^[\w-]{1,128}$/u);
export const TerminalTargetSchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    loginSessionId: UuidSchema,
    sessionId: UuidSchema,
    deviceId: UuidSchema,
    grantId: UuidSchema,
    grantVersion: z.number().int().positive(),
    rootFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    label: z.string().min(1).max(120),
  })
  .strict();
export type TerminalTarget = z.infer<typeof TerminalTargetSchema>;
const dimensions = {
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200),
};
const terminalIdentity = z.object({ id: TerminalIdSchema }).strict();
export const terminalRpcArguments = {
  environment: z.object({}).strict(),
  shells: z.object({}).strict(),
  list: z.object({}).strict(),
  create: z
    .object({
      request: z
        .object({
          id: TerminalIdSchema,
          ...dimensions,
          shellPath: z.string().min(1).max(1024).optional(),
        })
        .strict(),
    })
    .strict(),
  rename: terminalIdentity.extend({ title: z.string().trim().min(1).max(120) }),
  close: terminalIdentity,
  attach: terminalIdentity,
  retain: terminalIdentity,
};
export const TerminalRpcActionSchema = z.enum([
  'environment',
  'shells',
  'list',
  'create',
  'rename',
  'close',
  'attach',
  'retain',
]);
export const TerminalRequestSchema = z
  .object({
    version: z.literal(1),
    type: z.literal('terminal.request'),
    requestId: UuidSchema,
    action: TerminalRpcActionSchema,
    args: z.unknown(),
  })
  .strict()
  .superRefine((request, context) => {
    const parsed = terminalRpcArguments[request.action].safeParse(request.args);
    if (!parsed.success)
      context.addIssue({
        code: 'custom',
        path: ['args'],
        message: 'Invalid terminal action arguments',
      });
  });
export const TerminalInputSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('write'),
      sequence: z.number().int().positive(),
      data: z.string().max(65_536),
    })
    .strict(),
  z
    .object({
      type: z.literal('resize'),
      sequence: z.number().int().positive(),
      ...dimensions,
    })
    .strict(),
]);
const control = { version: z.literal(1), requestId: UuidSchema };
export const TerminalInputEnvelopeSchema = z
  .object({
    ...control,
    type: z.literal('terminal.input'),
    input: TerminalInputSchema,
  })
  .strict();
export const TerminalCancelSchema = z
  .object({ ...control, type: z.literal('terminal.cancel') })
  .strict();
/** Exactly one credit advances exactly one native stream item. */
export const TerminalNextSchema = z
  .object({ ...control, type: z.literal('terminal.next') })
  .strict();
export const WorkbenchTerminalBrowserFrameSchema = z.discriminatedUnion(
  'type',
  [
    TerminalRequestSchema,
    TerminalInputEnvelopeSchema,
    TerminalCancelSchema,
    TerminalNextSchema,
  ],
);
export type WorkbenchTerminalBrowserFrame = z.infer<
  typeof WorkbenchTerminalBrowserFrameSchema
>;
export type TerminalRequest = z.infer<typeof TerminalRequestSchema>;
export type TerminalInput = z.infer<typeof TerminalInputSchema>;
const TerminalShellSchema = z
  .object({
    path: z.string().max(1024),
    args: z.array(z.string().max(1024)).max(32),
    name: z.string().max(120),
  })
  .strict();
export const TerminalInfoSchema = z
  .object({
    id: TerminalIdSchema,
    title: z.string().max(120),
    shell: TerminalShellSchema,
    cwd: z.string().max(4096),
    ...dimensions,
    state: z.enum(['running', 'exited', 'failed']),
    exitCode: z.number().int().nullable(),
    error: z.string().max(8192).optional(),
  })
  .strict();
export const TerminalNativeFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('retained') }).strict(),
  z
    .object({
      type: z.literal('snapshot'),
      sequence: z.number().int().nonnegative(),
      screen: z.string().max(terminalMaximumScreenBytes),
      info: TerminalInfoSchema,
      writable: z.boolean(),
      inputWindow: z
        .object({
          maxBytes: z.number().int().positive(),
          frameOverheadBytes: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('output'),
      sequence: z.number().int().nonnegative(),
      data: z.string().max(terminalMaximumScreenBytes),
    })
    .strict(),
  z
    .object({
      type: z.literal('state'),
      info: TerminalInfoSchema,
      writable: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('ack'),
      sequence: z.number().int().positive(),
      refusal: z.enum(['read-only', 'not-running']).optional(),
    })
    .strict(),
]);
export const TerminalErrorSchema = z
  .object({
    code: z.string().max(120),
    message: z.string().max(8192),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const TerminalResultSchema = z
  .object({
    ...control,
    type: z.literal('terminal.result'),
    result: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), value: z.unknown().optional() }).strict(),
      z.object({ ok: z.literal(false), error: TerminalErrorSchema }).strict(),
    ]),
  })
  .strict();
export const TerminalFrameSchema = z
  .object({
    ...control,
    type: z.literal('terminal.frame'),
    frame: TerminalNativeFrameSchema,
  })
  .strict();
/** Large native screen snapshots are split without creating extra stream credits. */
export const TerminalFragmentSchema = z
  .object({
    ...control,
    type: z.literal('terminal.fragment'),
    index: z.number().int().min(0).max(31),
    total: z.number().int().min(1).max(32),
    data: z.string().max(131_072),
  })
  .strict()
  .refine((f) => f.index < f.total);
export const TerminalFinishedSchema = z
  .object({
    ...control,
    type: z.literal('terminal.finished'),
    error: TerminalErrorSchema.optional(),
  })
  .strict();
export const TerminalReadySchema = z
  .object({ version: z.literal(1), type: z.literal('terminal.ready') })
  .strict();
export const TerminalEndedSchema = z
  .object({
    version: z.literal(1),
    type: z.literal('terminal.ended'),
    error: TerminalErrorSchema.optional(),
  })
  .strict();
export const WorkbenchTerminalServerFrameSchema = z.discriminatedUnion('type', [
  TerminalReadySchema.safeExtend({
    target: TerminalTargetSchema,
    deviceName: z.string().min(1).max(120),
  }),
  TerminalResultSchema,
  TerminalFrameSchema,
  TerminalFragmentSchema,
  TerminalFinishedSchema,
  TerminalEndedSchema,
]);
export type WorkbenchTerminalServerFrame = z.infer<
  typeof WorkbenchTerminalServerFrameSchema
>;
const channel = { id: UuidSchema };
export const BridgeTerminalServerFrameSchema = z.discriminatedUnion('type', [
  z
    .object({
      version: z.literal(1),
      type: z.literal('terminal.open'),
      ...channel,
      target: TerminalTargetSchema,
    })
    .strict(),
  TerminalRequestSchema.safeExtend(channel),
  TerminalInputEnvelopeSchema.extend(channel),
  TerminalCancelSchema.extend(channel),
  TerminalNextSchema.extend(channel),
  z
    .object({
      version: z.literal(1),
      type: z.literal('terminal.end'),
      ...channel,
      revoke: z.boolean().optional(),
    })
    .strict(),
]);
export const BridgeTerminalClientFrameSchema = z.discriminatedUnion('type', [
  TerminalReadySchema.extend(channel),
  TerminalEndedSchema.extend(channel),
  TerminalResultSchema.extend(channel),
  TerminalFrameSchema.extend(channel),
  TerminalFragmentSchema.safeExtend(channel),
  TerminalFinishedSchema.extend(channel),
]);
export type BridgeTerminalServerFrame = z.infer<
  typeof BridgeTerminalServerFrameSchema
>;
export type BridgeTerminalClientFrame = z.infer<
  typeof BridgeTerminalClientFrameSchema
>;
