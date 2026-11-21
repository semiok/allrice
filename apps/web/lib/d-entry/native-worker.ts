import {
  ApiErrorSchema,
  type DEntrySelectionInput,
  type RequestContext,
} from '@allrice/contracts';
import { DEntryDependencyUnavailable } from './release-policy';

export class DEntryWorkerProblem extends Error {
  constructor(
    readonly status: number,
    readonly problem: ReturnType<typeof ApiErrorSchema.parse>,
  ) {
    super('The selected entry is not available');
  }
}

/** Original login Bearer only to the fixed existing Worker deployment address.
 * Never forwards a browser URL, Cookie, supplied identity or redirect. */
export async function requestDEntryWorker(
  input: {
    token: string;
    context: RequestContext;
    selection: DEntrySelectionInput;
    signal: AbortSignal;
  },
  path: 'native-owner' | 'native-resource' | 'native-rpc',
  fields: Record<string, unknown> = {},
) {
  input.signal.throwIfAborted();
  let base: URL;
  try {
    base = new URL(
      process.env.ALLRICE_WORKER_INTERNAL_URL?.trim() ||
        `http://127.0.0.1:${process.env.ALLRICE_WORKER_PORT ?? '3101'}`,
    );
  } catch (error) {
    throw new DEntryDependencyUnavailable('native-route', { cause: error });
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new DEntryDependencyUnavailable('native-route');
  const response = await fetch(new URL(`/internal/d-entry/${path}`, base), {
    method: 'POST',
    redirect: 'error',
    cache: 'no-store',
    signal: input.signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${input.token}`,
    },
    body: JSON.stringify({
      ...fields,
      organizationId: input.context.organizationId,
      selection: input.selection,
    }),
  }).catch((error) => {
    input.signal.throwIfAborted();
    throw new DEntryDependencyUnavailable('native-route', { cause: error });
  });
  if (!response.ok) {
    let problem: unknown;
    try {
      problem = await response.json();
    } catch (error) {
      throw new DEntryDependencyUnavailable('native-route', { cause: error });
    }
    const parsed = ApiErrorSchema.safeParse(problem);
    if (parsed.success)
      throw new DEntryWorkerProblem(response.status, parsed.data);
    throw new DEntryDependencyUnavailable('native-route');
  }
  return response;
}

export async function readDEntryWorkerJson<T>(
  response: Response,
  parse: (value: unknown) => T,
): Promise<T> {
  try {
    return parse(await response.json());
  } catch (error) {
    throw new DEntryDependencyUnavailable('native-route', { cause: error });
  }
}
