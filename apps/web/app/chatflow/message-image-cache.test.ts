import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageImageCache, imageReference } from './message-image-cache';

const image = {
  id: 'file-1',
  fileName: 'picture.png',
  mediaType: 'image/png',
  sizeBytes: 8,
  width: 640,
  height: 320,
  previewUrl: 'blob:preview',
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('native image cache with Allrice transport', () => {
  it('hands off the preview synchronously, deduplicates reads, and releases both URLs with the session', async () => {
    let finish!: (response: Response) => void;
    const bytes = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const request = vi.fn(async (url: string) =>
      url.endsWith('/sign')
        ? Response.json({ url: 'https://files.test/image' })
        : bytes,
    );
    vi.stubGlobal('fetch', request);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:durable');
    const revoked = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {});
    const cache = createMessageImageCache();
    const loader = cache.loader('company/user/session', {});
    expect(cache.handoff('company/user/session', {}, [image])).toEqual(
      new Set(['blob:preview']),
    );
    const ref = imageReference(image);
    expect(loader.peek?.(ref)).toBe('blob:preview');
    const first = loader(ref),
      second = loader(ref);
    expect(first).toBe(second);
    expect(revoked).not.toHaveBeenCalled();
    finish(
      new Response('image bytes', { headers: { 'content-type': 'image/png' } }),
    );
    await expect(first).resolves.toBe('blob:durable');
    expect(request).toHaveBeenCalledTimes(2);
    expect(revoked).toHaveBeenCalledWith('blob:preview');
    expect(
      cache.reference('company/user/session', {
        ...image,
        width: undefined,
        height: undefined,
      }),
    ).toMatchObject({ width: 640, height: 320 });
    cache.release('company/user/session');
    expect(revoked).toHaveBeenCalledWith('blob:durable');
    expect(loader.peek?.(ref)).toBeUndefined();
    cache.dispose();
  });

  it('isolates the same attachment id between viewers and retries failed loads', async () => {
    let fail = true;
    const request = vi.fn(async (url: string) => {
      if (url.endsWith('/sign')) {
        if (fail) throw new Error('offline');
        return Response.json({ url: 'https://files.test/image' });
      }
      return new Response('bytes', {
        headers: { 'content-type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', request);
    const cache = createMessageImageCache();
    const one = cache.loader('company/user-a/session', {
      'x-test-viewer': 'a',
    });
    const two = cache.loader('company/user-b/session', {
      'x-test-viewer': 'b',
    });
    const ref = imageReference(image);
    await expect(one(ref)).rejects.toThrow('offline');
    fail = false;
    const first = await one(ref);
    expect(two.peek?.(ref)).toBeUndefined();
    expect(await two(ref)).not.toBe(first);
    expect(
      request.mock.calls.filter(([url]) => url.endsWith('/sign')),
    ).toHaveLength(3);
    cache.dispose();
  });

  it('does not publish a late file read after leaving its session', async () => {
    let finish!: (response: Response) => void;
    const bytes = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/sign')
          ? Response.json({ url: 'https://files.test/image' })
          : bytes,
      ),
    );
    const cache = createMessageImageCache();
    const loader = cache.loader('session-a', {});
    const result = loader(imageReference(image));
    cache.release('session-a');
    finish(new Response('bytes'));
    await expect(result).rejects.toThrow('scope was released');
    expect(loader.peek?.(imageReference(image))).toBeUndefined();
    cache.dispose();
  });
});
