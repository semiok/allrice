/** Keep failures diagnosable without logging document contents, URLs or credentials. */
export function reportPreviewFailure(
  stage: 'artifact-request' | 'office-conversion',
  error: unknown,
  referenceId?: string,
) {
  const label = (value: unknown) =>
    typeof value === 'string' && /^[\w-]{1,80}$/.test(value)
      ? value
      : undefined;
  const causes: { name?: string; code?: string }[] = [];
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    causes.push({
      name: label(current.name),
      code: 'code' in current ? label(current.code) : undefined,
    });
    current = current.cause;
  }
  console.error('Document preview failed', {
    at: new Date().toISOString(),
    stage,
    referenceId: label(referenceId),
    releaseSha: label(process.env.ALLRICE_RELEASE_SHA),
    causes,
  });
}
