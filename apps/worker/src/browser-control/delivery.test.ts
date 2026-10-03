import { describe, expect, it } from 'vitest';
import { BrowserObservationSchema } from '@allrice/contracts';
import { browserScreenshotDelivery } from './delivery.js';
const observation = BrowserObservationSchema.parse({
  version: 1,
  id: '00000000-0000-4000-8000-000000000001',
  profileId: '00000000-0000-4000-8000-000000000002',
  fence: 1,
  revision: 1,
  url: 'https://example.com/',
  title: 'Example Domain',
  text: 'Example Domain',
  elements: [],
  screenshotObjectId: '00000000-0000-4000-8000-000000000003',
  capturedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  pageDigest: 'sha256:' + '1'.repeat(64),
});
describe('browser screenshot delivery', () => {
  it('links the validated screenshot without interpreting page text as a file identity', () => {
    const result = browserScreenshotDelivery({
      status: 'succeeded',
      observation,
    });
    expect(result.screenshot?.downloadUrl).toBe(
      '/api/v1/files/00000000-0000-4000-8000-000000000003/download?name=browser-00000000-0000-4000-8000-000000000001.png',
    );
    expect(result.screenshot?.mediaType).toBe('image/png');
  });
  it('never delivers an old or missing screenshot on a non-success receipt', () => {
    expect(
      browserScreenshotDelivery({ status: 'unknown', observation }),
    ).toEqual({});
    expect(
      browserScreenshotDelivery({ status: 'succeeded', observation: null }),
    ).toEqual({});
    expect(
      browserScreenshotDelivery({
        status: 'succeeded',
        observation: { ...observation, screenshotObjectId: null },
      }),
    ).toEqual({});
  });
});
