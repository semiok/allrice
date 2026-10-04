import { createHash } from 'node:crypto';
import {
  BrowserVerificationPlanSchema,
  BrowserVerificationReportSchema,
  StaticBrowserTargetSchema,
  staticBrowserDocumentUrl,
  type BrowserVerificationPlan,
  type BrowserVerificationReport,
  type BrowserAction,
  type BrowserObservation,
  type StaticBrowserTarget,
  canonicalRuntimeBridgeJson,
} from '@allrice/contracts';

/** The same finite interpreter drives authenticated local observations and the
 * fixed runsc renderer. Callers own authorization, screenshots and physical stop. */
export async function verifyStaticBrowser(input: {
  target: StaticBrowserTarget;
  plan: BrowserVerificationPlan;
  assertCurrent: () => Promise<void>;
  observe: () => Promise<BrowserObservation>;
  perform: (
    action: BrowserAction,
    observation: BrowserObservation | null,
  ) => Promise<void>;
  now?: () => number;
}): Promise<BrowserVerificationReport> {
  const target = StaticBrowserTargetSchema.parse(input.target),
    plan = BrowserVerificationPlanSchema.parse(input.plan),
    now = input.now ?? Date.now,
    start = now(),
    deadline = start + plan.timeoutMs,
    steps: BrowserVerificationReport['steps'] = [];
  let verdict: BrowserVerificationReport['verdict'] = 'passed',
    errorCode: string | null = null;
  const check = async () => {
    if (now() >= deadline) throw Error('STATIC_BROWSER_DEADLINE');
    await input.assertCurrent();
  };
  try {
    await check();
    await input.perform(
      { type: 'navigate', url: staticBrowserDocumentUrl(target) },
      null,
    );
    for (const [index, step] of plan.steps.entries()) {
      await check();
      let observation = await input.observe();
      await check();
      if (observation.url !== staticBrowserDocumentUrl(target))
        throw Error('STATIC_BROWSER_TARGET_CHANGED');
      let status: BrowserVerificationReport['steps'][number]['status'] =
          'completed',
        expected: string | null = null,
        actual: string | null = null,
        code: string | null = null;
      if (step.type === 'click' || step.type === 'fill') {
        const matches = observation.elements.filter(
          (e) => e.tag === step.selector.tag && e.label === step.selector.label,
        );
        if (matches.length !== 1)
          throw Error('STATIC_BROWSER_ELEMENT_AMBIGUOUS');
        const el = matches[0]!;
        if (
          el.sensitive ||
          (step.type === 'fill' && !['input', 'textarea'].includes(el.tag))
        )
          throw Error('STATIC_BROWSER_SENSITIVE_INPUT_DENIED');
        await input.perform(
          step.type === 'click'
            ? { type: 'click', elementId: el.id }
            : { type: 'fill', elementId: el.id, value: step.value },
          observation,
        );
        await check();
        observation = await input.observe();
        if (observation.url !== staticBrowserDocumentUrl(target))
          throw Error('STATIC_BROWSER_TARGET_CHANGED');
      } else {
        expected = step.expected;
        const text =
            step.type === 'title_equals' ? observation.title : observation.text,
          match =
            step.type === 'title_equals'
              ? text === step.expected
              : text.includes(step.expected),
          truncated =
            text.length >= (step.type === 'title_equals' ? 200 : 12000);
        const offset = Math.max(0, text.indexOf(step.expected) - 100);
        actual = text.slice(offset, offset + 2000);
        status = match ? 'passed' : truncated ? 'unknown' : 'failed';
        if (!match) {
          verdict = status;
          code =
            status === 'unknown'
              ? 'STATIC_BROWSER_OBSERVATION_TRUNCATED'
              : 'STATIC_BROWSER_ASSERTION_FAILED';
        }
      }
      steps.push({
        index,
        type: step.type,
        status,
        observationId: observation.id,
        pageDigest: observation.pageDigest,
        expected,
        actual,
        errorCode: code,
      });
      if (code) {
        errorCode = code;
        break;
      }
    }
    await check();
  } catch (error) {
    verdict = 'unknown';
    const message = error instanceof Error ? error.message : '';
    errorCode =
      /^(STATIC_BROWSER|BROWSER)_[A-Z_]+$/.test(message) &&
      message.length <= 120
        ? message
        : 'STATIC_BROWSER_EXECUTION_FAILED';
  }
  return BrowserVerificationReportSchema.parse({
    version: 1,
    target,
    planDigest: `sha256:${createHash('sha256').update(canonicalRuntimeBridgeJson(plan)).digest('hex')}`,
    startedAt: new Date(start).toISOString(),
    completedAt: new Date(now()).toISOString(),
    verdict,
    steps,
    errorCode,
  });
}
