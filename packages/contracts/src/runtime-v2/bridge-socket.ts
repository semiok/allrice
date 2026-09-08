import { z } from 'zod';

import { UuidSchema } from '../common.ts';

export const bridgeSocketPath = '/api/v1/bridge/socket';
export const bridgeSocketProtocol = 'allrice.bridge.v1';
export const bridgeSocketMaximumFrameBytes = 750_000;
export const bridgeSocketMaximumBufferedBytes = 1_500_000;

/** Transport envelopes carry no new execution permission or arbitrary HTTP URL. */
export const BridgeSocketRequestSchema = z
  .object({
    version: z.literal(1),
    type: z.literal('request'),
    id: UuidSchema,
    action: z.enum([
      'operation.next',
      'operation.start',
      'operation.heartbeat',
      'operation.output',
      'operation.receipts',
      'operation.service',
    ]),
    operationId: UuidSchema.optional(),
    body: z.unknown(),
  })
  .strict()
  .refine(
    (frame) =>
      frame.action === 'operation.next'
        ? frame.operationId === undefined
        : frame.operationId !== undefined,
    'exact operation identity required',
  );
export type BridgeSocketRequest = z.infer<typeof BridgeSocketRequestSchema>;

export const BridgeSocketResponseSchema = z
  .object({
    version: z.literal(1),
    type: z.literal('response'),
    id: UuidSchema,
    status: z.number().int().min(200).max(599),
    body: z.unknown(),
  })
  .strict();

export const BridgeSocketWelcomeSchema = z
  .object({
    version: z.literal(1),
    type: z.literal('welcome'),
    connectionId: UuidSchema,
    deviceId: UuidSchema,
    epoch: z.string().regex(/^[1-9][0-9]{0,18}$/),
    heartbeatMs: z.number().int().min(100).max(30_000),
    maximumFrameBytes: z.literal(bridgeSocketMaximumFrameBytes),
  })
  .strict();

export const BridgeSocketWakeupSchema = z
  .object({ version: z.literal(1), type: z.literal('wakeup') })
  .strict();

export const BridgeSocketMessageSchema = z.discriminatedUnion('type', [
  BridgeSocketResponseSchema,
  BridgeSocketWelcomeSchema,
  BridgeSocketWakeupSchema,
]);

export function bridgeSocketOperationPath(input: BridgeSocketRequest) {
  const frame = BridgeSocketRequestSchema.parse(input);
  const prefix = '/api/v1/bridge/device/operations';
  return frame.action === 'operation.next'
    ? `${prefix}/next`
    : `${prefix}/${frame.operationId}/${frame.action.slice('operation.'.length)}`;
}
