// Pure public-route doubles; no browser/Host/network is started by this file.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Route } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import {
  panelsReplayOrigin,
  servePanelsReplay,
  type PanelsReplayAssetReceipt,
} from './employee-panels-replay-route';

function route(path: string, method = 'GET') {
  return {
    request: () =>
      ({
        url: () => new URL(path, panelsReplayOrigin).href,
        method: () => method,
      }) as ReturnType<Route['request']>,
    fulfill: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
}
const icon = await readFile(
  new URL('../../../apps/web/public/favicon.ico', import.meta.url),
);
const html = '<!doctype html><html><body>fixed reference bytes</body></html>';

describe('reference replay resource contract', () => {
  it('serves the actual ICO entity and retains its exact URL/method/hash receipt', async () => {
    expect([...icon.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    const images = icon.readUInt16LE(4);
    expect(images).toBeGreaterThan(0);
    for (let i = 0; i < images; i++) {
      const entry = 6 + 16 * i;
      expect(
        icon.readUInt32LE(entry + 12) + icon.readUInt32LE(entry + 8),
      ).toBeLessThanOrEqual(icon.length);
    }
    const r = route('/favicon.ico'),
      receipts: PanelsReplayAssetReceipt[] = [];
    const business = vi.fn();
    await servePanelsReplay(r, html, icon, receipts, business);
    expect(r.fulfill).toHaveBeenCalledExactlyOnceWith({
      status: 200,
      contentType: 'image/x-icon',
      body: icon,
    });
    expect(r.abort).not.toHaveBeenCalled();
    expect(business).not.toHaveBeenCalled();
    expect(receipts).toEqual([
      {
        url: panelsReplayOrigin + '/favicon.ico',
        method: 'GET',
        contentType: 'image/x-icon',
        bytes: icon.length,
        sha256: createHash('sha256').update(icon).digest('hex'),
        fulfilledWithStatus: 200,
        fulfilled: true,
      },
    ]);
  });

  it('serves the immutable document verbatim without inserting a link/style or script', async () => {
    const r = route('/?kind=materials&state=denied'),
      receipts: PanelsReplayAssetReceipt[] = [];
    await servePanelsReplay(r, html, icon, receipts, vi.fn());
    expect(r.fulfill).toHaveBeenCalledExactlyOnceWith({
      contentType: 'text/html',
      body: html,
    });
    expect(receipts).toEqual([]);
  });

  it('keeps business requests, including denied writes, on the existing business route', async () => {
    const r = route('/api/v1/workbench/files?workspaceId=synthetic', 'POST');
    const business = vi.fn(async () => {});
    await servePanelsReplay(r, html, icon, [], business);
    expect(business).toHaveBeenCalledExactlyOnceWith(r);
    expect(r.fulfill).not.toHaveBeenCalled();
  });

  it.each([
    ['http://other.invalid/favicon.ico', 'GET'],
    ['/favicon.ico?unknown=1', 'GET'],
    ['/unknown.js', 'GET'],
    ['/favicon.ico', 'POST'],
    ['/', 'POST'],
  ])('refuses an unprovided fixture resource %s %s', async (path, method) => {
    const r = route(path, method),
      receipts: PanelsReplayAssetReceipt[] = [];
    const business = vi.fn();
    await servePanelsReplay(r, html, icon, receipts, business);
    expect(r.abort).toHaveBeenCalledExactlyOnceWith('failed');
    expect(r.fulfill).not.toHaveBeenCalled();
    expect(business).not.toHaveBeenCalled();
    expect(receipts).toEqual([]);
  });

  it('retains a failed fulfillment receipt and propagates the original error', async () => {
    const failure = new Error('actual fixture fulfillment failure');
    const r = route('/favicon.ico'),
      receipts: PanelsReplayAssetReceipt[] = [];
    r.fulfill.mockRejectedValueOnce(failure);
    await expect(
      servePanelsReplay(r, html, icon, receipts, vi.fn()),
    ).rejects.toBe(failure);
    expect(receipts).toMatchObject([
      { fulfilled: false, error: String(failure) },
    ]);
    expect(r.abort).not.toHaveBeenCalled();
  });
});
