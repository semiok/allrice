// Compile-only types for the reviewed native module. The prefix accommodates
// relative Worker imports; it does not change their emitted runtime paths.
declare module '*/dsh/allrice-web-cancellation.mjs' {
  export function createWebCallScope(): {
    run<T>(
      key: string,
      operation: (signal: AbortSignal) => Promise<T>,
    ): Promise<T>;
    cancel(key: string): Promise<{ settled: true }>;
  };
  export function requestCancellableWeb<T>(
    request: (method: string, params: Record<string, unknown>) => Promise<T>,
    method: string,
    cancelMethod: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;
}
