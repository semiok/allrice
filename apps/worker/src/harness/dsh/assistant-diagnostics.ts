import { types } from 'node:util';
import {
  AssistantFailureDiagnosticsSchema,
  type AssistantFailureDiagnostics,
} from '@allrice/contracts';
export {
  AssistantDiagnosticCodeSchema,
  AssistantFailureDiagnosticsSchema,
  type AssistantFailureDiagnostics,
} from '@allrice/contracts';

/** JSON-RPC delivers plain JSON. Reject accessors/proxies/cycles even for direct
 * callers, before a schema parser can accidentally execute their properties. */
function plainData(value: unknown, depth = 0): boolean {
  if (typeof value !== 'object' || value === null) return true;
  if (depth > 4 || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    prototype !== Array.prototype
  )
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 65) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === 'string' &&
      !!descriptor &&
      'value' in descriptor &&
      plainData(descriptor.value, depth + 1)
    );
  });
}

export function parseAssistantFailureDiagnostics(
  value: unknown,
): AssistantFailureDiagnostics | undefined {
  try {
    if (!plainData(value)) return undefined;
    const result = AssistantFailureDiagnosticsSchema.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

// Do not inspect, traverse or mutate an arbitrary original error/cause/result.
// This sidecar also works with frozen objects and never alters serialization or
// retry policy. Partial result objects pass it to their later completion error.
const errorDiagnostics = new WeakMap<object, AssistantFailureDiagnostics>();
export function attachAssistantFailureDiagnostics(
  error: unknown,
  diagnostics: unknown,
) {
  if (typeof error !== 'object' || error === null || types.isProxy(error))
    return;
  const safe = parseAssistantFailureDiagnostics(diagnostics);
  if (safe) errorDiagnostics.set(error, safe);
}
export function getAssistantFailureDiagnostics(
  error: unknown,
): AssistantFailureDiagnostics | undefined {
  if (typeof error !== 'object' || error === null || types.isProxy(error))
    return undefined;
  return parseAssistantFailureDiagnostics(errorDiagnostics.get(error));
}
