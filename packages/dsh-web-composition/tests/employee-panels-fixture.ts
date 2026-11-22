import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import type { writeEmployeePanelsReferenceCarrier } from './employee-panels-reference-carrier';

/** Build only the separate synthetic owner package. Product is loaded from the
 * installed tarball through its actual public module-table export. */
export async function writeEmployeePanelsFixture(
  artifacts: string,
  reference?: Awaited<ReturnType<typeof writeEmployeePanelsReferenceCarrier>>,
) {
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL('./fixtures/employee-panels/client.tsx', import.meta.url),
      ),
    ],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    jsx: 'automatic',
    outdir: join(artifacts, 'panels-fixture'),
    // This separately loaded test package shares a document with the installed
    // product. Keep source-qualified CSS Module names out of its short names.
    minifyIdentifiers: false,
    minifySyntax: true,
    minifyWhitespace: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    external: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      '@deepseek-ai/dsh-client-ui-primitives',
      'zod',
    ],
    metafile: true,
  });
  const js = result.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
  const css = result.outputFiles.find((file) =>
    file.path.endsWith('.css'),
  )!.text;
  const inputs = Object.keys(result.metafile.inputs);
  if (
    inputs.some((input) =>
      /src\/employee-panels\.tsx$|chatflow-client\.tsx$|\/(?:shiki|katex)\//.test(
        input,
      ),
    )
  )
    throw Error(
      'Fixture bundled a product contribution or forbidden page controller',
    );
  // Keep the default payload unchanged for historical A/B/C/D callers. Only
  // the formal suite opts into a separately identified reference executable.
  const client = reference
    ? `window.__ModuleLoader__.load({id:'@allrice/composition-test-fixture',factory:(require)=>{
const requestedReference=new URLSearchParams(location.search).get('allricePanelsReference');if(requestedReference!==null&&requestedReference!==${JSON.stringify(reference.id)})throw Error('Unknown reference carrier identity');const referenceMode=requestedReference!==null;
const fixture=referenceMode?(()=>{const module={exports:{}};const exports=module.exports;${reference.javascript}\nreturn module.exports.createReferenceFixture();})():(()=>{const module={exports:{}};const exports=module.exports;${js}\nreturn module.exports.createFixture(require);})();
const apply=fixture.apply;fixture.apply=(ctx)=>{ctx.effect(()=>{const style=document.createElement('style');if(referenceMode)style.dataset.panelsReferenceCarrier=${JSON.stringify(reference.metadataSha256)};else style.dataset.syntheticPanelsOwner='';style.textContent=referenceMode?${JSON.stringify(reference.surface)}:${JSON.stringify(css)};document.head.append(style);return()=>style.remove();});apply(ctx);};return fixture;}});\n`
    : `window.__ModuleLoader__.load({id:'@allrice/composition-test-fixture',factory:(require)=>{const module={exports:{}};const exports=module.exports;${js}\nconst fixture=module.exports.createFixture(require);const apply=fixture.apply;fixture.apply=(ctx)=>{ctx.effect(()=>{const style=document.createElement('style');style.dataset.syntheticPanelsOwner='';style.textContent=${JSON.stringify(css)};document.head.append(style);return()=>style.remove();});apply(ctx);};return fixture;}});\n`;
  const file = join(artifacts, 'panels-fixture-client.js');
  await writeFile(file, client);
  await writeFile(
    join(artifacts, 'panels-fixture-build.json'),
    JSON.stringify(
      {
        source:
          'test-only synthetic owner; real installed product is required at runtime',
        inputs,
        clientSha256: createHash('sha256').update(client).digest('hex'),
        cssBytes: Buffer.byteLength(css),
        ...(reference
          ? {
              referenceCarrier: {
                id: reference.id,
                metadataSha256: reference.metadataSha256,
                entrySha256: reference.metadata.entrySha256,
                artifacts: reference.metadata.artifacts,
                combinedCssSha256: createHash('sha256')
                  .update(reference.surface)
                  .digest('hex'),
              },
            }
          : {}),
      },
      null,
      2,
    ),
  );
  return pathToFileURL(file);
}
