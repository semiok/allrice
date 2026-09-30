import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { McpBearerSchema, McpError } from '@allrice/contracts';
const envelopeSchema = z
  .object({
    iv: z.string().regex(/^[a-f0-9]{24}$/),
    tag: z.string().regex(/^[a-f0-9]{32}$/),
    ciphertext: z
      .string()
      .regex(/^[a-f0-9]+$/)
      .max(131072),
  })
  .strict();
export function encryptionKey(value: string | undefined) {
  if (!value || !/^[a-f0-9]{64}$/i.test(value))
    throw new McpError('MCP_CREDENTIAL_UNAVAILABLE');
  return Buffer.from(value, 'hex');
}
export function seal(
  value: string,
  key: Buffer,
  associated: Buffer,
  json = false,
) {
  if (Buffer.byteLength(value) > 65536) throw new McpError('MCP_LIMIT');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associated);
  return {
    iv: iv.toString('hex'),
    ciphertext: Buffer.concat([
      cipher.update(json ? value : McpBearerSchema.parse(value)),
      cipher.final(),
    ]).toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  };
}
export function unseal(
  value: unknown,
  key: Buffer,
  associated: Buffer,
  json = false,
) {
  try {
    const envelope = envelopeSchema.parse(value);
    const cipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.iv, 'hex'),
    );
    cipher.setAAD(associated);
    cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    const plaintext = Buffer.concat([
      cipher.update(Buffer.from(envelope.ciphertext, 'hex')),
      cipher.final(),
    ]).toString('utf8');
    return json ? plaintext : McpBearerSchema.parse(plaintext);
  } catch {
    throw new McpError('MCP_CREDENTIAL_UNAVAILABLE');
  }
}
