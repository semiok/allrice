/** Acceptance-only JSON framing. Never extract JSON from surrounding prose or
 * preserve raw text/SyntaxError messages in diagnostics. */
import { createHash } from 'node:crypto';

const stageCodes = {
  artifact_envelope: 'P27_CODEX_JSON_ARTIFACT_ENVELOPE_INVALID',
  child_report: 'P27_CODEX_JSON_CHILD_REPORT_INVALID',
  parent_answer: 'P27_CODEX_JSON_PARENT_ANSWER_INVALID',
  ordinary_answer: 'P27_CODEX_JSON_ORDINARY_ANSWER_INVALID',
} as const;
export type P27CodexJsonStage = keyof typeof stageCodes;
export type P27CodexJsonObservation = Readonly<{
  stage: P27CodexJsonStage;
  inputType: 'string' | 'missing' | 'other';
  length: number | null;
  bytes: number | null;
  digest: string | null;
  hasFence: boolean;
  isFence: boolean;
  isJson: boolean;
  isObject: boolean;
  accepted: boolean;
  failure:
    | null
    | 'missing'
    | 'empty'
    | 'too_large'
    | 'invalid_fence'
    | 'unexpected_fence'
    | 'invalid_json'
    | 'duplicate_key'
    | 'not_object';
  artifactId?: string;
  childRunId?: string;
  deliveryId?: string;
}>;
export type P27CodexJsonObserver = (
  observation: P27CodexJsonObservation,
) => void;

const errorObservations = new WeakMap<object, P27CodexJsonObservation>();
export class P27CodexJsonError extends Error {
  override readonly name = 'P27CodexJsonError';
  readonly code: (typeof stageCodes)[P27CodexJsonStage];
  constructor(readonly observation: P27CodexJsonObservation) {
    super(stageCodes[observation.stage]);
    this.code = stageCodes[observation.stage];
    errorObservations.set(this, observation);
  }
}
export function codexJsonDiagnostics(error: unknown) {
  // No getter/property reads on arbitrary provider errors or forged prototypes.
  return error !== null && typeof error === 'object'
    ? (errorObservations.get(error) ?? null)
    : null;
}

function duplicateKeys(source: string) {
  // Run only after JSON.parse has established valid grammar. Count decoded
  // object keys so escaped aliases cannot silently use last-key-wins.
  const stack: { object: boolean; key?: boolean; seen?: Set<string> }[] = [];
  for (const match of source.matchAll(
    /"(?:\\.|[^"\\])*"|[{}[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
  )) {
    const token = match[0],
      top = stack.at(-1);
    if (token === '{') stack.push({ object: true, key: true, seen: new Set() });
    else if (token === '[') stack.push({ object: false });
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && top?.object) top.key = true;
    else if (token.startsWith('"') && top?.object && top.key) {
      const key = JSON.parse(token) as string;
      if (top.seen!.has(key)) return true;
      top.seen!.add(key);
      top.key = false;
    }
  }
  return false;
}

/** Plain object JSON, or exactly one complete triple-backtick/tilde JSON fence
 * (optional json label, case-insensitive). The server artifact envelope is
 * always plain JSON: formatting tolerance applies only to model-owned text. */
export function parseP27CodexJson(
  input: unknown,
  stage: P27CodexJsonStage,
  observe?: P27CodexJsonObserver,
): { value: Record<string, unknown>; observation: P27CodexJsonObservation } {
  const observation = {
    stage,
    inputType:
      typeof input === 'string'
        ? 'string'
        : input == null
          ? 'missing'
          : 'other',
    length: typeof input === 'string' ? input.length : null,
    bytes: typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : null,
    digest:
      typeof input === 'string'
        ? `sha256:${createHash('sha256').update(input).digest('hex')}`
        : null,
    hasFence: false,
    isFence: false,
    isJson: false,
    isObject: false,
    accepted: false,
    failure: null,
  } as {
    -readonly [K in keyof P27CodexJsonObservation]: P27CodexJsonObservation[K];
  };
  const reject = (
    failure: NonNullable<P27CodexJsonObservation['failure']>,
  ): never => {
    observation.failure = failure;
    const safe = Object.freeze({ ...observation });
    observe?.(safe);
    throw new P27CodexJsonError(safe);
  };
  if (typeof input !== 'string') return reject('missing');
  if (observation.bytes! > 140000) return reject('too_large');
  const trimmed = input.trim();
  if (!trimmed) return reject('empty');
  const fenceLines = trimmed.match(/^[\t ]*(?:```|~~~)[^\r\n]*$/gm) ?? [];
  observation.hasFence = fenceLines.length > 0;
  const fence = /^(```|~~~)(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n\1[\t ]*$/i.exec(
    trimmed,
  );
  observation.isFence = !!fence && fenceLines.length === 2;
  if (observation.hasFence && !observation.isFence)
    return reject('invalid_fence');
  if (observation.isFence && stage === 'artifact_envelope')
    return reject('unexpected_fence');
  const source = observation.isFence ? fence![2]! : trimmed;
  let value: unknown;
  try {
    value = JSON.parse(source);
    observation.isJson = true;
  } catch {
    return reject('invalid_json');
  }
  if (duplicateKeys(source)) return reject('duplicate_key');
  observation.isObject =
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!observation.isObject) return reject('not_object');
  observation.accepted = true;
  const safe = Object.freeze({ ...observation });
  observe?.(safe);
  return { value: value as Record<string, unknown>, observation: safe };
}
