import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const Envelope = z
  .object({
    version: z.literal(1),
    iv: z.string().regex(/^[a-f0-9]{24}$/),
    tag: z.string().regex(/^[a-f0-9]{32}$/),
    ciphertext: z
      .string()
      .max(32768)
      .regex(/^[a-f0-9]*$/),
  })
  .strict();
export type BrowserSecretScope = {
  organizationId: string;
  tenantWorkspaceId: string;
  browserWorkspaceId: string;
  profileId: string;
  actorId: string;
  inputId: string;
  fence: number;
  observationId: string;
  elementId: string;
  expiresAt: string;
};
const aad = (s: BrowserSecretScope) =>
  Buffer.from(
    JSON.stringify([
      'allrice.browser.direct-control.v1',
      s.organizationId,
      s.tenantWorkspaceId,
      s.browserWorkspaceId,
      s.profileId,
      s.actorId,
      s.inputId,
      s.fence,
      s.observationId,
      s.elementId,
      s.expiresAt,
    ]),
  );
function key(value = process.env.ALLRICE_BROWSER_CONTROL_KEY) {
  if (!value || !/^[a-f0-9]{64}$/i.test(value))
    throw Error('BROWSER_DIRECT_INPUT_UNAVAILABLE');
  return Buffer.from(value, 'hex');
}
/** Dedicated purpose/AAD. Never uses MCP, provider or Bridge pairing credentials. */
export function sealBrowserDirectInput(
  value: string,
  scope: BrowserSecretScope,
  configuredKey?: string,
) {
  if (!value || Buffer.byteLength(value) > 8192 || value.includes('\0'))
    throw Error('BROWSER_DIRECT_INPUT_INVALID');
  const material = key(configuredKey),
    bytes = Buffer.from(value),
    iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', material, iv);
    cipher.setAAD(aad(scope));
    return {
      version: 1 as const,
      iv: iv.toString('hex'),
      ciphertext: Buffer.concat([
        cipher.update(bytes),
        cipher.final(),
      ]).toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
    };
  } finally {
    material.fill(0);
    bytes.fill(0);
  }
}
export function openBrowserDirectInput(
  envelope: unknown,
  scope: BrowserSecretScope,
  now: number,
  configuredKey?: string,
): Buffer {
  let material: Buffer | undefined;
  try {
    if (Date.parse(scope.expiresAt) <= now) throw Error();
    const record = Envelope.parse(envelope);
    material = key(configuredKey);
    const cipher = createDecipheriv(
      'aes-256-gcm',
      material,
      Buffer.from(record.iv, 'hex'),
    );
    cipher.setAAD(aad(scope));
    cipher.setAuthTag(Buffer.from(record.tag, 'hex'));
    return Buffer.concat([
      cipher.update(Buffer.from(record.ciphertext, 'hex')),
      cipher.final(),
    ]);
  } catch {
    throw Error('BROWSER_DIRECT_INPUT_UNAVAILABLE');
  } finally {
    material?.fill(0);
  }
}
