// Finite projections only: Playwright messages can contain selectors, URLs,
// page text or credentials. Never persist arbitrary exception messages/logs.
const messages = {
  'identity-http': 'Current identity request failed',
  'identity-scope-mismatch':
    'Current identity differs from the authorized scope',
  'owner-http': 'Current native owner request failed',
  'owner-binding-mismatch': 'Native generation or exact owner changed',
  'navigation-http': 'Owner route did not return HTTP 200',
  'navigation-origin-mismatch': 'Owner route left the authorized origin',
  'scope-mismatch': 'Displayed employee scope differs',
};

export function browserFailure(code, status) {
  if (!Object.hasOwn(messages, code))
    throw new Error('Unknown diagnostic code');
  const error = new Error(messages[code]);
  error.diagnostic = { code, message: messages[code] };
  if (Number.isInteger(status)) error.diagnostic.status = status;
  return error;
}

function diagnostic(stage, error) {
  const type = [
    'Error',
    'TimeoutError',
    'AbortError',
    'TypeError',
    'SyntaxError',
  ].includes(error?.name)
    ? error.name
    : 'UnknownError';
  // Only errors created here carry a controlled message/status projection.
  if (
    error instanceof Error &&
    Object.hasOwn(messages, error.diagnostic?.code) &&
    error.message === messages[error.diagnostic.code]
  ) {
    const { code, status } = error.diagnostic;
    return {
      stage,
      type,
      code,
      message: messages[code],
      ...(Number.isInteger(status) ? { status } : {}),
    };
  }
  return {
    stage,
    type,
    code: stage + (type === 'TimeoutError' ? '-timeout' : '-error'),
    message: 'Native browser operation failed; private call log omitted',
  };
}

function describe(failure) {
  return `${failure.stage}/${failure.code} ${failure.type}${failure.status === undefined ? '' : ` HTTP ${failure.status}`}: ${failure.message}`;
}

/** Existing single-page read, extracted so failure/capture composition is tested
 * without launching a browser or presenting injected pages as Dev evidence. */
export async function readPage(
  page,
  { origin, employeeInstanceId, recipe, identity, path, screenshot },
) {
  let stage = 'identity-before';
  try {
    await identity();
    stage = 'navigation';
    const response = await page.goto(new URL(recipe.path, origin).href);
    if (!response || response.status() !== 200)
      throw browserFailure('navigation-http', response?.status());
    if (new URL(page.url()).origin !== origin)
      throw browserFailure('navigation-origin-mismatch');
    stage = 'locator';
    await page.locator(recipe.locator).first().waitFor({ state: 'visible' });
    stage = 'scope';
    const scope = await page
      .locator(recipe.scopeLocator)
      .first()
      .getAttribute(recipe.scopeAttribute);
    if (scope !== employeeInstanceId) throw browserFailure('scope-mismatch');
    if (recipe.text !== undefined) {
      stage = 'text';
      await page
        .getByText(recipe.text, { exact: true })
        .first()
        .waitFor({ state: 'visible' });
    }
    stage = 'fonts';
    await page.evaluate(() => globalThis.document.fonts.ready);
    stage = 'identity-after';
    await identity();
    stage = 'capture';
    await page.screenshot({ path, fullPage: true });
    return {
      status: 'passed',
      screenshot,
      reason:
        '真实浏览器当前授权read-only页面/owner locator可见；禁写/禁WS，不证明模型过程或业务读写闭环',
    };
  } catch (error) {
    const failure = diagnostic(stage, error);
    let captured = null;
    let captureFailure = null;
    try {
      await page.screenshot({ path, fullPage: true });
      captured = screenshot;
    } catch (captureError) {
      captureFailure = diagnostic('capture', captureError);
    }
    return {
      status: 'failed',
      screenshot: captured,
      failure,
      captureFailure,
      reason: describe(failure),
      noScreenshotReason: captured ? null : describe(captureFailure),
    };
  }
}
