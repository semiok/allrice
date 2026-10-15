import { z } from 'zod';
import { TimestampSchema, UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';

/** Exact HTTPS origins only. Wildcards and URL credentials are never grants. */
export const SandboxHttpsOriginSchema = z
  .string()
  .max(253)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.origin === value &&
        !url.port &&
        !url.username &&
        !url.password &&
        /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) &&
        url.hostname.includes('.') &&
        !/\.(?:localhost|local|internal|test|invalid|onion)$/.test(
          url.hostname,
        ) &&
        !/^\d+(?:\.\d+)*$/.test(url.hostname) &&
        url.hostname
          .split('.')
          .every(
            (label) =>
              label.length > 0 &&
              label.length <= 63 &&
              !label.startsWith('-') &&
              !label.endsWith('-'),
          )
      );
    } catch {
      return false;
    }
  });

export const SandboxNetworkRequestSchema = z
  .object({
    mode: z.literal('controlled_https'),
    origins: z
      .array(SandboxHttpsOriginSchema)
      .min(1)
      .max(32)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();
export type SandboxNetworkRequest = z.infer<typeof SandboxNetworkRequestSchema>;

/** Installed by an administrator for one execution grant. A tool request can
 * select a subset, never add destinations or permit input transfer itself. */
export const SandboxNetworkGrantSchema = SandboxNetworkRequestSchema.extend({
  version: z.literal(1),
  allowInputTransfer: z.boolean(),
});
export type SandboxNetworkGrant = z.infer<typeof SandboxNetworkGrantSchema>;

/** Created by the authority adapter, never accepted as model-supplied proof.
 * Cloud and Bridge share policy semantics but cannot borrow each other's grant. */
export const SandboxNetworkLeaseSchema = z
  .object({
    version: z.literal(1),
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    runId: UuidSchema,
    operationId: UuidSchema,
    attemptId: UuidSchema,
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('cloud'), targetId: UuidSchema }).strict(),
      z
        .object({
          kind: z.literal('bridge'),
          targetId: UuidSchema,
          deviceId: UuidSchema,
        })
        .strict(),
    ]),
    policyDigest: ChecksumSchema,
    grantId: UuidSchema,
    grantVersion: z.number().int().positive(),
    network: SandboxNetworkRequestSchema,
    expiresAt: TimestampSchema,
    maximumConnections: z.number().int().min(1).max(32),
    maximumBytes: z.number().int().min(1024).max(1_073_741_824),
  })
  .strict();
export type SandboxNetworkLease = z.infer<typeof SandboxNetworkLeaseSchema>;

export const SandboxNetworkErrorCodeSchema = z.enum([
  'SANDBOX_NETWORK_DENIED',
  'SANDBOX_NETWORK_REVOKED',
  'SANDBOX_NETWORK_UNAVAILABLE',
  'SANDBOX_NETWORK_PROTOCOL',
  'SANDBOX_NETWORK_DNS',
  'SANDBOX_NETWORK_CONNECT_TIMEOUT',
  'SANDBOX_NETWORK_CONNECT_FAILED',
  'SANDBOX_NETWORK_LIMIT',
]);
export type SandboxNetworkErrorCode = z.infer<
  typeof SandboxNetworkErrorCodeSchema
>;

const messages: Record<SandboxNetworkErrorCode, string> = {
  SANDBOX_NETWORK_DENIED: '访问的网络地址未获授权，或指向不可访问的内部地址。',
  SANDBOX_NETWORK_REVOKED: '联网授权已撤销或到期，连接已关闭。',
  SANDBOX_NETWORK_UNAVAILABLE: '沙箱联网通道暂时不可用。',
  SANDBOX_NETWORK_PROTOCOL:
    '连接方式不受支持；仅允许通过代理访问已授权的 HTTPS 地址。',
  SANDBOX_NETWORK_DNS: '无法解析已授权的网络地址。',
  SANDBOX_NETWORK_CONNECT_TIMEOUT: '连接已授权的服务超时。',
  SANDBOX_NETWORK_CONNECT_FAILED: '与已授权服务的连接中断或建立失败。',
  SANDBOX_NETWORK_LIMIT: '本次联网达到连接数、传输量或缓冲上限。',
};
export function sandboxNetworkErrorMessage(code: unknown): string | undefined {
  const parsed = SandboxNetworkErrorCodeSchema.safeParse(code);
  return parsed.success ? messages[parsed.data] : undefined;
}
