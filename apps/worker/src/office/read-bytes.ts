import { officeError } from './package.js';

export async function readOfficeBytes(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 20 * 1024 * 1024) {
        await reader.cancel();
        officeError('Office 文件超过 20 MB');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
