import {
  ActualNativeCallSelectorProjectionSchema,
  AdoptedHumanSourceProjectionSchema,
  MemoryOriginSelectorProjectionSchema,
  OrdinaryOriginClassificationProjectionSchema,
  StoredHumanSourceSelectorProjectionSchema,
  type ActualNativeCallSelectorProjection,
  type AdoptedHumanSourceProjection,
  type MemoryOriginSelectorProjection,
  type RequestContext,
  type StoredHumanSourceSelectorProjection,
} from '@allrice/contracts';
import {
  assertBusinessScope,
  denyBusinessProjection,
  readBusinessProjection,
  sameBusinessScope,
  type HumanSourceSources,
  type OrdinaryOriginSources,
} from './contract.ts';

function assertHumanSource(
  context: RequestContext,
  target: ActualNativeCallSelectorProjection,
  source: AdoptedHumanSourceProjection,
  dependency: string,
) {
  assertBusinessScope(context, source.scope, dependency);
  if (
    !sameBusinessScope(target.scope, source.scope) ||
    source.threadId !== target.threadId ||
    source.b !== target.b ||
    source.executionBoundaryRef !== target.executionBoundaryRef ||
    source.rootOriginRef !== target.rootOriginRef ||
    source.nativeCall.rootSessionRef !== target.nativeCall.rootSessionRef ||
    source.nativeCall.parentSessionRef !== target.nativeCall.parentSessionRef ||
    source.nativeCall.sessionRef !== target.nativeCall.sessionRef ||
    source.nativeCall.callRef !== target.nativeCall.callRef ||
    source.nativeCall.toolId !== target.nativeCall.toolId ||
    source.nativeCall.toolVersion !== target.nativeCall.toolVersion
  )
    denyBusinessProjection(dependency);
}

export async function resolveAdoptedHumanSource(
  sources: HumanSourceSources,
  context: RequestContext,
  input: ActualNativeCallSelectorProjection,
  signal?: AbortSignal,
) {
  const target = ActualNativeCallSelectorProjectionSchema.parse(input);
  const read = sources.adopted;
  const source = await readBusinessProjection(
    'source.adopted',
    read && (() => read(context, target, signal)),
    AdoptedHumanSourceProjectionSchema,
    signal,
  );
  assertHumanSource(context, target, source, 'source.adopted');
  return source;
}

export async function readStoredHumanSource(
  sources: HumanSourceSources,
  context: RequestContext,
  input: StoredHumanSourceSelectorProjection,
  signal?: AbortSignal,
) {
  const target = StoredHumanSourceSelectorProjectionSchema.parse(input);
  const read = sources.stored;
  const source = await readBusinessProjection(
    'source.stored',
    read && (() => read(context, target, signal)),
    AdoptedHumanSourceProjectionSchema,
    signal,
  );
  assertHumanSource(context, target, source, 'source.stored');
  if (source.sourceRef !== target.sourceRef)
    denyBusinessProjection('source.stored');
  return source;
}

/** Exclusion fact only. The memory owner still checks scope/private/current,
 * lifecycle and expiry. No missing/failed source becomes a false exclusion. */
export async function classifyOrdinaryMemoryOrigin(
  sources: OrdinaryOriginSources,
  input: MemoryOriginSelectorProjection,
  signal?: AbortSignal,
) {
  const target = MemoryOriginSelectorProjectionSchema.parse(input);
  const read = sources.classify;
  const fact = await readBusinessProjection(
    'source.ordinary',
    read && (() => read(target, signal)),
    OrdinaryOriginClassificationProjectionSchema,
    signal,
  );
  if (
    fact.sourceCheck !==
    (target.sourceType === 'message' || target.sourceType === 'checkpoint'
      ? 'checked'
      : 'not-applicable')
  )
    denyBusinessProjection('source.ordinary');
  return fact;
}
