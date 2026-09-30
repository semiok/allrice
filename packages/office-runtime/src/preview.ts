import { Context } from '@deepseek-ai/cordis';
import {
  OfficeToPdf,
  OfficeSourceKey,
  type OfficeExtension,
} from '@deepseek-ai/dsh-office-to-pdf';

let provider: Promise<OfficeToPdf> | undefined;

/** The pinned DSH provider owns conversion, admission, cancellation and cache limits.
 * AllRice supplies an already-authorized immutable object, never a client path. */
export async function previewOfficePdf(input: {
  objectId: string;
  checksum: string;
  sizeBytes: number;
  format: OfficeExtension;
  read: (signal: AbortSignal, maximum: number) => Promise<Uint8Array>;
  signal?: AbortSignal;
}) {
  provider ??= (async () => {
    const context = new Context();
    const plugin = context.plugin(OfficeToPdf, {});
    await plugin.await();
    return context.officeToPdf;
  })().catch((error) => {
    provider = undefined;
    throw error;
  });
  return (await provider).convert(
    {
      extension: input.format,
      priority: 'foreground',
      source: {
        key: OfficeSourceKey(`allrice-object:${input.objectId}`),
        version: input.checksum,
        bytes: input.sizeBytes,
        read: async (signal, maximum) => ({
          bytes: await input.read(signal, maximum),
          version: input.checksum,
        }),
      },
    },
    input.signal,
  );
}
