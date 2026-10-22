'use client';

type Registration = {
  id: string;
  chunk?: string;
  factory: (require: (id: string) => unknown) => unknown;
};
const modules = new Map<string, Promise<unknown>>();
let pending: Promise<unknown> = Promise.resolve();

/** DSH's lazy chunks share one registration slot. All native client consumers
 * serialize only registration, preserving the official package bytes. */
export function loadNativeClientModule<T>(input: {
  packageId: string;
  chunk?: string;
  url: string;
  dependencies: Readonly<Record<string, unknown>>;
  cacheKey?: string;
  storage?: Pick<
    Storage,
    'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
  >;
}): Promise<T> {
  const key = input.cacheKey ?? `${input.packageId}:${input.chunk ?? 'client'}`;
  let loaded = modules.get(key);
  if (!loaded) {
    loaded = pending
      .catch(() => undefined)
      .then(
        () =>
          new Promise<unknown>((resolve, reject) => {
            const previous = Reflect.get(window, '__ModuleLoader__');
            let result: unknown;
            let failure: unknown;
            const facade = {
              storage: input.storage,
              load(registration: Registration) {
                try {
                  if (
                    registration.id !== input.packageId ||
                    registration.chunk !== input.chunk
                  )
                    throw Error('原生组件来源不匹配');
                  result = registration.factory((id) => {
                    if (Object.hasOwn(input.dependencies, id))
                      return input.dependencies[id];
                    throw Error(`原生组件依赖不可用：${id}`);
                  });
                } catch (error) {
                  failure = error;
                }
              },
            };
            Reflect.set(window, '__ModuleLoader__', facade);
            const script = document.createElement('script');
            script.src = input.url;
            const restore = () => {
              if (Reflect.get(window, '__ModuleLoader__') === facade) {
                if (previous === undefined)
                  Reflect.deleteProperty(window, '__ModuleLoader__');
                else Reflect.set(window, '__ModuleLoader__', previous);
              }
              script.remove();
            };
            script.onload = () => {
              restore();
              if (result) resolve(result);
              else reject(failure ?? Error('原生组件未就绪'));
            };
            script.onerror = () => {
              restore();
              reject(Error('原生组件加载失败'));
            };
            document.head.append(script);
          }),
      )
      .catch((error) => {
        modules.delete(key);
        throw error;
      });
    modules.set(key, loaded);
    pending = loaded.catch(() => undefined);
  }
  return loaded as Promise<T>;
}
