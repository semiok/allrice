import { createHash } from 'node:crypto';
import type { Route } from 'playwright-core';

export const panelsReplayOrigin = 'http://allrice-panels-rev2.invalid';
export type PanelsReplayAssetReceipt = {
  url: string;
  method: string;
  contentType: 'image/x-icon';
  bytes: number;
  sha256: string;
  fulfilledWithStatus: 200;
  fulfilled: boolean;
  error?: string;
};

/** Test-only reference resource routing. The document bytes stay untouched;
 * favicon is the real repository ICO, not an empty/HTML image response. */
export async function servePanelsReplay<
  R extends Pick<Route, 'request' | 'fulfill' | 'abort'>,
>(
  route: R,
  html: string,
  favicon: Buffer,
  receipts: PanelsReplayAssetReceipt[],
  businessRoute: (route: R) => Promise<void>,
) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== panelsReplayOrigin) return route.abort('failed');
  if (url.pathname.startsWith('/api/v1/')) return businessRoute(route);
  if (request.method() !== 'GET') return route.abort('failed');
  if (url.pathname === '/')
    return route.fulfill({ contentType: 'text/html', body: html });
  if (url.pathname !== '/favicon.ico' || url.search)
    return route.abort('failed');
  const receipt: PanelsReplayAssetReceipt = {
    url: request.url(),
    method: request.method(),
    contentType: 'image/x-icon',
    bytes: favicon.length,
    sha256: createHash('sha256').update(favicon).digest('hex'),
    fulfilledWithStatus: 200,
    fulfilled: false,
  };
  receipts.push(receipt);
  try {
    await route.fulfill({
      status: 200,
      contentType: receipt.contentType,
      body: favicon,
    });
    receipt.fulfilled = true;
  } catch (error) {
    receipt.error = String(error);
    throw error;
  }
}
