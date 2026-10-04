import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  BrowserVerificationPlanSchema,
  browserVerificationMatchesPlan,
  staticBrowserDocumentUrl,
  type StaticBrowserTarget,
  type BrowserObservation,
} from '@allrice/contracts';
import { verifyStaticBrowser } from './static-verification.ts';
const target: StaticBrowserTarget = {
  version: 1,
  versionId: randomUUID(),
  objectId: randomUUID(),
  checksum: 'sha256:' + 'a'.repeat(64),
  mediaType: 'text/html',
  sizeBytes: 100,
  fileName: 'index.html',
  sourceOperationId: null,
  sourceSessionId: randomUUID(),
};
const plan = BrowserVerificationPlanSchema.parse({
  version: 1,
  steps: [
    { type: 'text_contains', expected: '0' },
    { type: 'click', selector: { tag: 'button', label: 'Compute' } },
    { type: 'text_contains', expected: '42' },
  ],
});
function fixture() {
  let text = 'Compute 0';
  const perform = vi.fn(async (a: { type: string }) => {
    if (a.type === 'click') text = 'Compute 42';
  });
  const observe = vi.fn(async (): Promise<BrowserObservation> => ({
    version: 1,
    id: randomUUID(),
    profileId: randomUUID(),
    fence: 1,
    revision: 1,
    capturedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
    url: staticBrowserDocumentUrl(target),
    title: 'fixed page',
    text,
    pageDigest: 'sha256:' + 'b'.repeat(64),
    elements: [
      {
        id: 'e1',
        tag: 'button',
        inputType: '',
        label: 'Compute',
        sensitive: false,
      },
    ],
    screenshotObjectId: null,
  }));
  return {
    target,
    plan,
    perform,
    observe,
    assertCurrent: vi.fn(async () => {}),
  };
}
describe('finite saved-page verification', () => {
  it('uses fresh observed IDs, deterministic assertions and never runs a build', async () => {
    const f = fixture(),
      report = await verifyStaticBrowser(f);
    expect(report.verdict).toBe('passed');
    expect(f.perform.mock.calls.map((c) => c[0].type)).toEqual([
      'navigate',
      'click',
    ]);
    expect(f.observe.mock.calls).toHaveLength(4);
    expect(browserVerificationMatchesPlan(report, plan)).toBe(true);
    expect(
      browserVerificationMatchesPlan(
        { ...report, steps: report.steps.slice(0, 1) },
        plan,
      ),
    ).toBe(false);
  });
  it('retains an actual failed assertion and does not retry the click', async () => {
    const f = fixture();
    f.perform.mockImplementation(async () => {});
    const report = await verifyStaticBrowser(f);
    expect(report.verdict).toBe('failed');
    expect(report.steps.at(-1)).toMatchObject({
      actual: 'Compute 0',
      expected: '42',
      status: 'failed',
    });
    expect(f.perform.mock.calls.map((c) => c[0].type)).toEqual([
      'navigate',
      'click',
    ]);
  });
  it('rejects target drift and never clicks a different page', async () => {
    const f = fixture(),
      original = await f.observe();
    f.observe.mockResolvedValue({ ...original, url: 'https://example.com/' });
    const r = await verifyStaticBrowser(f);
    expect(r).toMatchObject({
      verdict: 'unknown',
      errorCode: 'STATIC_BROWSER_TARGET_CHANGED',
    });
    expect(f.perform.mock.calls).toHaveLength(1);
  });
  it('stops on revoked authority without replay or a fabricated pass', async () => {
    const f = fixture();
    f.assertCurrent.mockRejectedValue(Error('authority unavailable'));
    expect(await verifyStaticBrowser(f)).toMatchObject({
      verdict: 'unknown',
      steps: [],
      errorCode: 'STATIC_BROWSER_EXECUTION_FAILED',
    });
    expect(f.perform).not.toHaveBeenCalled();
  });
  it('does not infer failure or pass from a truncated observation', async () => {
    const f = fixture(),
      o = await f.observe();
    f.observe.mockResolvedValue({ ...o, text: 'x'.repeat(12000) });
    expect(await verifyStaticBrowser(f)).toMatchObject({
      verdict: 'unknown',
      errorCode: 'STATIC_BROWSER_OBSERVATION_TRUNCATED',
    });
  });
  it('rejects ambiguous or sensitive controls rather than selecting one', async () => {
    const f = fixture(),
      o = await f.observe();
    f.observe.mockResolvedValue({
      ...o,
      elements: [o.elements[0]!, o.elements[0]!],
    });
    const report = await verifyStaticBrowser(f);
    expect(report).toMatchObject({
      verdict: 'unknown',
      errorCode: 'STATIC_BROWSER_ELEMENT_AMBIGUOUS',
    });
    expect(f.perform.mock.calls).toHaveLength(1);
    f.observe.mockResolvedValue({
      ...o,
      elements: [{ ...o.elements[0]!, sensitive: true }],
    });
    expect(await verifyStaticBrowser(f)).toMatchObject({
      verdict: 'unknown',
      errorCode: 'STATIC_BROWSER_SENSITIVE_INPUT_DENIED',
    });
  });
});
