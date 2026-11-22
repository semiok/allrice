import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Consume the published native module-table artifact, without copying its code.
export function nativeClientModule(name, from = import.meta.url) {
  const resolve = createRequire(from);
  const file = resolve.resolve(`${name}/client`);
  let factory;
  runInNewContext(
    readFileSync(file, 'utf8'),
    {
      window: {
        __ModuleLoader__: {
          load: (entry) => {
            factory = entry.factory;
          },
        },
      },
      queueMicrotask: globalThis.queueMicrotask,
      AbortController: globalThis.AbortController,
      AbortSignal: globalThis.AbortSignal,
      console: globalThis.console,
    },
    { filename: file },
  );
  if (!factory)
    throw new Error(`Native client artifact did not register: ${name}`);
  return factory(createRequire(file));
}
