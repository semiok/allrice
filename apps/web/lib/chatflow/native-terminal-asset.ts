import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import ledger from '../../app/dsh-upstream/upstream.json';

export const nativeTerminalVersion = '0.2.1-rc.2';
const packages = {
  gateway: {
    package: 'dsh-api-gateway',
    file: 'client.browser.js',
  },
  model: {
    package: 'dsh-api-terminal-controller',
    file: 'client.js',
  },
  screen: {
    package: 'dsh-client-ui-sidebar-terminal',
    file: 'client.terminal.js',
  },
} as const;
const assets = new Map<string, Promise<Buffer>>();

function verifiedAsset(kind: keyof typeof packages) {
  let pending = assets.get(kind);
  if (!pending) {
    pending = (async () => {
      const asset = packages[kind];
      const name = `@deepseek-ai/${asset.package}`;
      const relative = `node_modules/${name}`;
      let directory = join(process.cwd(), relative);
      const manifest = await readFile(
        join(directory, 'package.json'),
        'utf8',
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        directory = join(process.cwd(), 'apps/web', relative);
        return readFile(join(directory, 'package.json'), 'utf8');
      });
      const pkg = ledger.componentSets
        .find((group) => group.id === 'native-terminal')
        ?.packages?.find((entry) => entry.name === name);
      const expected =
        pkg && 'assets' in pkg
          ? pkg.assets?.find((entry) => entry.path === `lib/${asset.file}`)
              ?.sha256
          : undefined;
      const bytes = await readFile(join(directory, 'lib', asset.file));
      if (
        JSON.parse(manifest).version !== nativeTerminalVersion ||
        pkg?.version !== nativeTerminalVersion ||
        !expected ||
        createHash('sha256').update(bytes).digest('hex') !== expected
      )
        throw Error('原生终端组件版本或校验值不匹配');
      return bytes;
    })().catch((error) => {
      assets.delete(kind);
      throw error;
    });
    assets.set(kind, pending);
  }
  return pending;
}

/** Serve the fixed official chunks without rebuilding their model or emulator.
 * The model's lexical Storage capability is supplied by the authenticated UI
 * adapter so pending close intents and bindings stay inside their AllRice owner. */
export async function nativeTerminalAssetResponse(
  kind: keyof typeof packages,
  request?: Request,
) {
  if (
    request &&
    new URL(request.url).searchParams.get('version') !== nativeTerminalVersion
  )
    return new Response('原生终端组件版本不匹配', {
      status: 409,
      headers: { 'Cache-Control': 'no-store' },
    });
  const bytes = await verifiedAsset(kind);
  const payload =
    kind === 'model'
      ? Buffer.concat([
          Buffer.from('(function(localStorage){\n'),
          bytes,
          Buffer.from('\n})(window.__ModuleLoader__.storage);\n'),
        ])
      : bytes;
  return new Response(new Uint8Array(payload), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=3600',
      'X-DSH-Version': nativeTerminalVersion,
      'X-DSH-Source-SHA256': createHash('sha256').update(bytes).digest('hex'),
    },
  });
}
