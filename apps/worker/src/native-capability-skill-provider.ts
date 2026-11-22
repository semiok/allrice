import {
  BuiltinSkillSourceSelectorSchema,
  PersonalSkillPinSchema,
  type BuiltinSkillSourceSelector,
  type PersonalSkillPin,
} from '@allrice/contracts';
import type {
  BuiltinSkillSourcesPort,
  createPostgresPersonalSkillPackageSource,
} from '@allrice/database';
import type { Context } from '@deepseek-ai/cordis';
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProviderControl,
} from '@deepseek-ai/dsh-skill';

export type NativeCapabilitySkillConfiguration = {
  /** Host-selected exact sources, not the repository's entire source catalog. */
  builtinSkills: readonly BuiltinSkillSourceSelector[];
  personalSkills: boolean;
};
type Host = {
  builtin: BuiltinSkillSourcesPort;
  personal: ReturnType<typeof createPostgresPersonalSkillPackageSource>;
  /** Both closures and the personal source must bind the same trusted target. */
  requireCurrent(signal: AbortSignal): Promise<void>;
  readConfiguration(
    signal: AbortSignal,
  ): Promise<NativeCapabilitySkillConfiguration>;
};
type Locator =
  | { kind: 'builtin'; selector: BuiltinSkillSourceSelector }
  | { kind: 'personal'; pin: PersonalSkillPin };
const provider = 'allrice-capabilities';
const resourceBase = {
  kind: 'opaque' as const,
  description:
    'This provider exposes instruction bodies only; relative resource bytes are not exposed.',
};
const unavailable = () => {
  throw Error('native_capability_skill_unavailable');
};
function parseLocator(input: unknown): Locator {
  if (!input || typeof input !== 'object') return unavailable();
  if ('kind' in input && input.kind === 'builtin' && 'selector' in input)
    return {
      kind: 'builtin',
      selector: BuiltinSkillSourceSelectorSchema.parse(input.selector),
    };
  if ('kind' in input && input.kind === 'personal' && 'pin' in input)
    return {
      kind: 'personal',
      pin: PersonalSkillPinSchema.parse(input.pin),
    };
  return unavailable();
}
function allowed(config: NativeCapabilitySkillConfiguration, locator: Locator) {
  if (locator.kind === 'personal') return config.personalSkills;
  return config.builtinSkills.some(
    (pin) =>
      pin.id === locator.selector.id &&
      pin.version === locator.selector.version &&
      pin.contentChecksum === locator.selector.contentChecksum &&
      pin.bundleChecksum === locator.selector.bundleChecksum,
  );
}
function throwFailures(errors: unknown[]) {
  const distinct = errors.filter(
    (error, index) => errors.indexOf(error) === index,
  );
  if (distinct.length === 1) throw distinct[0];
  if (distinct.length)
    throw new AggregateError(
      distinct,
      'native_capability_skill_cleanup_failed',
      {
        cause: distinct[0],
      },
    );
}

/** Call synchronously in the target's Cordis context with `skills` injected
 * (e.g. ctx.inject(['skills'], apply)). No production mount or identity/config
 * producer is installed here. DSH owns registration/cache.
 * The host must invalidate on current/config changes and await disposal before
 * releasing sources; native caller cancellation can race ahead of provider IO. */
export function registerNativeCapabilitySkillProvider(
  ctx: Context,
  host: Host,
) {
  if (
    typeof host.requireCurrent !== 'function' ||
    typeof host.readConfiguration !== 'function'
  )
    return unavailable();
  let control: SkillProviderControl;
  const pending = new Set<Promise<unknown>>();
  const settledFailures = new Set<unknown>();
  const configuration = async (signal: AbortSignal) => {
    await host.requireCurrent(signal);
    signal.throwIfAborted();
    const value = await host.readConfiguration(signal);
    signal.throwIfAborted();
    if (
      !value ||
      !Array.isArray(value.builtinSkills) ||
      typeof value.personalSkills !== 'boolean'
    )
      return unavailable();
    return {
      builtinSkills: value.builtinSkills.map((pin) =>
        BuiltinSkillSourceSelectorSchema.parse(pin),
      ),
      personalSkills: value.personalSkills,
    };
  };
  const joined = <T>(
    caller: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const signal = caller
      ? AbortSignal.any([control.signal, caller])
      : control.signal;
    const task = (async () => {
      try {
        signal.throwIfAborted();
        const result = await work(signal);
        signal.throwIfAborted();
        return result;
      } catch (error) {
        if (
          signal.aborted &&
          error !== signal.reason &&
          !(
            error instanceof AggregateError &&
            error.errors.includes(signal.reason)
          )
        )
          throw new AggregateError(
            [error, signal.reason],
            'native_capability_skill_cancelled',
            { cause: error },
          );
        throw error;
      }
    })();
    pending.add(task);
    // Observe without replacing the actual promise used by the caller/disposer.
    void task.then(
      () => pending.delete(task),
      (error) => {
        // Native caller abort can hide a later source/close failure. Transfer
        // that exact failure to disposal before releasing its pending record.
        if (signal.aborted && error !== signal.reason)
          settledFailures.add(error);
        pending.delete(task);
      },
    );
    return task;
  };
  const read = async (
    locator: Locator,
    signal: AbortSignal,
  ): Promise<SkillDefinition> => {
    if (locator.kind === 'builtin') {
      const value = await host.builtin.readPackage(locator.selector, signal);
      if (!value.source.sourceEnabled) return unavailable();
      return {
        name: value.source.name,
        description: value.source.description,
        invocation: {
          modelInvocable: value.source.modelInvocable,
          userInvocable: value.source.userInvocable,
        },
        content: value.content,
        source: 'allrice-managed',
        provider,
        resourceBase,
      };
    }
    const { definition } = await host.personal.readPackage(locator.pin, signal);
    return {
      name: definition.name,
      description: definition.description,
      invocation: definition.invocation,
      ...(definition.whenToUse === undefined
        ? {}
        : { whenToUse: definition.whenToUse }),
      ...(definition.metadata === undefined
        ? {}
        : { metadata: definition.metadata }),
      content: definition.content,
      source: 'allrice-managed',
      provider,
      resourceBase,
    };
  };
  const dispose = ctx.effect(function* () {
    // Cordis disposes in reverse order: native unregister/abort, then actual IO.
    yield async () => {
      const results = await Promise.allSettled([...pending]);
      const errors = [
        ...settledFailures,
        ...results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        ),
      ];
      settledFailures.clear();
      throwFailures(errors);
    };
    yield ctx.skills.registerProvider((nativeControl) => {
      control = nativeControl;
      return {
        name: provider,
        list: (options) =>
          joined(options.signal, async (signal) => {
            const config = await configuration(signal);
            const locators: Locator[] = config.builtinSkills.map(
              (selector) => ({
                kind: 'builtin',
                selector,
              }),
            );
            if (config.personalSkills)
              for (const pin of await host.personal.listPackagePins(signal))
                locators.push({ kind: 'personal', pin });
            const candidates: SkillCandidate[] = [];
            for (const locator of locators) {
              const definition = await read(locator, signal);
              const summary = {
                name: definition.name,
                description: definition.description,
                invocation: definition.invocation,
                source: definition.source,
                provider: definition.provider,
                resourceBase: definition.resourceBase,
                ...(definition.whenToUse === undefined
                  ? {}
                  : { whenToUse: definition.whenToUse }),
                ...(definition.metadata === undefined
                  ? {}
                  : { metadata: definition.metadata }),
              };
              candidates.push({
                ...summary,
                rank: BUNDLED_SKILL_RANK,
                locator,
              });
            }
            const current = await configuration(signal);
            if (locators.some((locator) => !allowed(current, locator)))
              return unavailable();
            return candidates;
          }),
        get: (candidate, options) =>
          joined(options.signal, async (signal) => {
            const locator = parseLocator(candidate.locator);
            if (!allowed(await configuration(signal), locator))
              return unavailable();
            const definition = await read(locator, signal);
            if (!allowed(await configuration(signal), locator))
              return unavailable();
            return definition;
          }),
      };
    });
  }, 'AllRice capability Skill sources');
  return { invalidate: () => control.invalidate(), dispose };
}
