import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export const runtime = 'nodejs';
/** The exact pinned official client chunk, including PDF.js worker, fonts and notices. */
export async function GET() {
  // next start uses apps/web as cwd; the custom server uses the repository root.
  // Bundler require.resolve yields a module ID rather than an on-disk path.
  const asset =
    'node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js';
  const bytes = await readFile(join(process.cwd(), asset)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return readFile(join(process.cwd(), 'apps/web', asset));
    },
  );
  return new Response(bytes, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
