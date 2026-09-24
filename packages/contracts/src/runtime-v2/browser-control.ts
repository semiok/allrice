import { z } from 'zod';
import { TimestampSchema, UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';

/** Shared cloud/Bridge protocol, not a new execution authority. P21 implements cloud only. */
export const browserControlVersion = 1;
/** Observation freshness is shared by cloud and local controllers/admission. */
export const browserObservationLifetimeMs = 60_000;
export function browserObservationIsFresh(
  observation: Pick<BrowserObservation, 'capturedAt' | 'expiresAt'>,
  now: number,
) {
  const captured = Date.parse(observation.capturedAt);
  const expires = Date.parse(observation.expiresAt);
  return (
    Number.isFinite(now) &&
    Number.isFinite(captured) &&
    Number.isFinite(expires) &&
    captured <= now + 1000 &&
    expires > now &&
    expires > captured &&
    expires - captured <= browserObservationLifetimeMs
  );
}
const text = z
  .string()
  .max(4000)
  .refine((s) => !s.includes('\0'));
export const BrowserUrlSchema = z
  .string()
  .max(2048)
  .superRefine((s, ctx) => {
    try {
      const u = new URL(s);
      if (
        u.protocol !== 'https:' ||
        u.username ||
        u.password ||
        (u.port && u.port !== '443') ||
        u.hash
      )
        throw Error();
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Exact public HTTPS URL required',
      });
    }
  });
export const BrowserProfileSchema = z
  .object({
    version: z.literal(1),
    /** Prepared cloud and supported Bridge browsers can browse public HTTPS without a
     * tenant-maintained website list. Existing exact-origin profiles retain
     * their semantics; both drivers still pin public IPs per connection. */
    network: z.literal('public_https').optional(),
    origins: z
      .array(
        BrowserUrlSchema.refine((s) => {
          try {
            return new URL(s).origin === s;
          } catch {
            return false;
          }
        }),
      )
      .max(8),
    allowUploads: z.boolean().default(false),
    allowDownloads: z.boolean().default(false),
    allowHumanCredentials: z.boolean().default(false),
    lifetimeMs: z.number().int().min(10000).max(600000).default(300000),
    maximumFileBytes: z.number().int().min(1).max(2000000).default(1000000),
  })
  .strict()
  .refine((p) => new Set(p.origins).size === p.origins.length)
  .refine((p) => p.network === 'public_https' || p.origins.length > 0);
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>;
export const BrowserElementSchema = z
  .object({
    id: z.string().regex(/^e[0-9]{1,4}$/),
    tag: z.enum(['a', 'button', 'input', 'textarea', 'select']),
    label: z.string().max(200),
    inputType: z.string().max(40),
    sensitive: z.boolean(),
  })
  .strict();
export const BrowserObservationSchema = z
  .object({
    version: z.literal(1),
    id: UuidSchema,
    profileId: UuidSchema,
    fence: z.number().int().positive(),
    revision: z.number().int().positive(),
    capturedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    url: z.string().max(2048),
    title: z.string().max(200),
    text: z.string().max(12000),
    pageDigest: ChecksumSchema,
    elements: z.array(BrowserElementSchema).max(200),
    screenshotObjectId: UuidSchema.nullable(),
  })
  .strict();
export type BrowserObservation = z.infer<typeof BrowserObservationSchema>;
const elementId = BrowserElementSchema.shape.id;
export const BrowserActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('observe') }).strict(),
  z.object({ type: z.literal('navigate'), url: BrowserUrlSchema }).strict(),
  z.object({ type: z.literal('click'), elementId }).strict(),
  z.object({ type: z.literal('fill'), elementId, value: text }).strict(),
  z
    .object({
      type: z.literal('sensitive_fill'),
      elementId,
      inputId: UuidSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('upload'),
      elementId,
      objectId: UuidSchema,
      checksum: ChecksumSchema,
      fileName: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z0-9._-]+$/),
    })
    .strict(),
  z.object({ type: z.literal('download'), elementId }).strict(),
  // Created only by the trusted renderer request interceptor, never by model/UI.
  z
    .object({
      type: z.literal('request'),
      parentOperationId: UuidSchema,
      url: BrowserUrlSchema,
      method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
      urlDigest: ChecksumSchema,
      bodyDigest: ChecksumSchema,
      bodyBytes: z.number().int().nonnegative().max(2500000),
    })
    .strict(),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export const BrowserCommandSchema = z
  .object({
    version: z.literal(1),
    workspaceId: UuidSchema,
    profileId: UuidSchema,
    actor: z.enum(['agent', 'human']),
    fence: z.number().int().positive(),
    observationId: UuidSchema.nullable(),
    action: BrowserActionSchema,
  })
  .strict();
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;
export const BrowserControlRequestSchema = z
  .object({
    requestId: UuidSchema,
    expectedFence: z.number().int().positive(),
    control: z.enum(['human', 'agent', 'paused', 'closed']),
    observationId: UuidSchema.nullable(),
  })
  .strict();
export type BrowserControlRequest = z.infer<typeof BrowserControlRequestSchema>;
export const BrowserHttpRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('act'),
      requestId: UuidSchema,
      command: BrowserCommandSchema.refine(
        (c) => c.actor === 'human' && c.action.type !== 'request',
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('control'),
      id: UuidSchema,
      request: BrowserControlRequestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('input'),
      id: UuidSchema,
      fence: z.number().int().positive(),
      observationId: UuidSchema,
      elementId,
      value: z.string().min(1).max(8192),
    })
    .strict(),
  z
    .object({
      kind: z.literal('grant'),
      targetId: UuidSchema,
      ownerId: UuidSchema,
      profile: BrowserProfileSchema,
      enabled: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('revoke_grant'), id: UuidSchema }).strict(),
]);
export const BrowserWorkspaceStateSchema = z.enum([
  'starting',
  'agent',
  'takeover_pending',
  'human',
  'resume_pending',
  'pause_pending',
  'paused',
  'close_pending',
  'closed',
  'unknown',
]);
export type BrowserWorkspaceState = z.infer<typeof BrowserWorkspaceStateSchema>;
export function browserObservationCurrent(
  o: BrowserObservation,
  input: { profileId: string; fence: number; now: number },
) {
  return (
    o.profileId === input.profileId &&
    o.fence === input.fence &&
    Date.parse(o.capturedAt) <= input.now &&
    browserObservationIsFresh(o, input.now)
  );
}
export function browserOriginAllowed(url: string, profile: BrowserProfile) {
  const parsed = BrowserUrlSchema.safeParse(url);
  return (
    parsed.success &&
    (profile.network === 'public_https' ||
      profile.origins.includes(new URL(parsed.data).origin))
  );
}
