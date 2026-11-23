import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { beforeAll, expect, it, vi } from 'vitest';
import type { startEmployeeWebEntry } from '../src/employee-web-entry';
import type { AppWebEntry } from '@deepseek-ai/dsh-client-web';
import { employeeWebKernelOptions } from '../build-web-entry.mjs';

let script: string;
beforeAll(async () => {
  // Compile the actual public release, not a fake AppWebEntry implementation.
  const result = await build({
    ...employeeWebKernelOptions,
    stdin: {
      contents:
        "export { startEmployeeWebEntry } from './src/employee-web-entry'; export { AppWebEntry } from '@deepseek-ai/dsh-client-web';",
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    outdir: '/unit-native-kernel',
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.svg': 'dataurl',
      '.wasm': 'dataurl',
    },
  });
  script = result.outputFiles!.find((file) => file.path.endsWith('.js'))!.text;
});

function documentKernel() {
  const sandbox: Record<string, unknown> & { module: { exports: unknown } } = {
    module: { exports: {} },
    console: { ...console, error: vi.fn() },
    AbortController,
    AbortSignal,
    DOMException,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
  };
  // Only the import-time character decoder element and framework-free
  // BootPage DOM are needed: fail/cancel precedes native plugin activation.
  // This is not visual/DOM QA and supplies no graph or access baseline.
  class Element {
    children: Element[] = [];
    parentElement: Element | null = null;
    dataset = {};
    style = { setProperty() {} };
    className = '';
    textContent = '';
    append(...children: Element[]) {
      for (const child of children) {
        child.parentElement = this;
        this.children.push(child);
      }
    }
    remove() {
      if (this.parentElement)
        this.parentElement.children = this.parentElement.children.filter(
          (child) => child !== this,
        );
      this.parentElement = null;
    }
    replaceChildren(...children: Element[]) {
      for (const child of this.children) child.parentElement = null;
      this.children = [];
      this.append(...children);
    }
  }
  sandbox.document = {
    compatMode: 'CSS1Compat',
    createElement: () => new Element(),
  };
  runInNewContext(script, sandbox);
  const api = sandbox.module.exports as {
    startEmployeeWebEntry: typeof startEmployeeWebEntry;
    AppWebEntry: typeof AppWebEntry;
  };
  const root = new Element();
  return {
    ...api,
    container: root as unknown as HTMLElement,
    root,
    run: vi.spyOn(api.AppWebEntry.prototype, 'run'),
    dispose: vi.spyOn(api.AppWebEntry.prototype, 'dispose'),
  };
}

it('joins pending injection/startup and real cleanup before the public dispose and closed result', async () => {
  const native = documentKernel();
  const injection = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const lifetime = native.startEmployeeWebEntry(native.container, {
    applyRequiredInjections: async (current) => {
      signal = current;
      await injection.promise;
    },
    cleanup: () => {
      cleaning.resolve();
      return cleanup.promise;
    },
  });
  await Promise.resolve();
  expect(signal).toBeDefined();
  expect(() =>
    native.startEmployeeWebEntry(native.container, {
      applyRequiredInjections: async () => {},
      cleanup: async () => {},
    }),
  ).toThrow('already has a startup owner');
  const closing = lifetime.close();
  expect(lifetime.close()).toBe(closing);
  expect(signal!.aborted).toBe(true);
  await expect(lifetime.started).resolves.toEqual({ state: 'cancelled' });
  expect(native.dispose).not.toHaveBeenCalled();
  injection.resolve();
  await cleaning.promise;
  expect(native.dispose).not.toHaveBeenCalled();
  cleanup.resolve();
  await expect(closing).resolves.toEqual({ state: 'closed' });
  expect(native.run).toHaveBeenCalledTimes(1);
  expect(native.dispose).toHaveBeenCalledTimes(1);
  expect(native.root.children).toHaveLength(0);
});

it('records actual onFailure even though the public AppWebEntry.run resolves', async () => {
  const native = documentKernel();
  const reason = new Error('Required runtime inputs are unavailable');
  const lifetime = native.startEmployeeWebEntry(native.container, {
    applyRequiredInjections: () => Promise.reject(reason),
    cleanup: async () => {},
  });
  await expect(native.run.mock.results[0]!.value).resolves.toBeUndefined();
  await expect(lifetime.started).resolves.toEqual({ state: 'failed', reason });
  await expect(lifetime.close()).resolves.toEqual({ state: 'closed' });
  expect(native.dispose).toHaveBeenCalledTimes(1);
});

it('preserves unknown cleanup, still disposes the public root, and never retries close', async () => {
  const native = documentKernel();
  const cleanup = vi.fn(async () => {
    throw new Error('A real owned resource has not closed');
  });
  const lifetime = native.startEmployeeWebEntry(native.container, {
    applyRequiredInjections: async () => {
      throw new Error('Runtime unbound');
    },
    cleanup,
  });
  await lifetime.started;
  const closing = lifetime.close();
  expect((await closing).state).toBe('unknown');
  expect(lifetime.close()).toBe(closing);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(native.dispose).toHaveBeenCalledTimes(1);
  expect(native.root.children).toHaveLength(0);
});
