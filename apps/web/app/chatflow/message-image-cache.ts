import { HistoricalImageCache } from './dsh-upstream/images/historical-images';
import type { ImageLoader } from './dsh-upstream/images/MessageImage';
import type { Attachment } from './chatflow-types';
import { readJson } from './chatflow-utils';

// Host faces for the unchanged DSH cache lifecycle. Allrice supplies its
// authenticated file transport instead of mounting another Session controller.
export type SessionId = string;
export interface ImageAttachmentRef {
  attachmentId: string;
  mediaType: string;
  name?: string;
  width?: number;
  height?: number;
}
export interface Context {
  effect(factory: () => () => void, label: string): () => void;
}
export interface SessionBinding {
  ctx: Context;
  session: {
    readAttachment(id: string): Promise<
      | {
          ok: true;
          value: { attachment: { mediaType: string }; data: Uint8Array };
        }
      | { ok: false; error: { code: string; message: string } }
    >;
  };
}
export interface ISessions {
  binding(id: SessionId): SessionBinding | undefined;
}

function lifetime() {
  const cleanups = new Set<() => void>();
  return {
    effect(factory: () => () => void) {
      const cleanup = factory();
      const dispose = () => {
        if (!cleanups.delete(dispose)) return;
        cleanup();
      };
      cleanups.add(dispose);
      return dispose;
    },
    dispose() {
      for (const cleanup of [...cleanups]) cleanup();
    },
  };
}

export function imageReference(attachment: Attachment): ImageAttachmentRef {
  return {
    attachmentId: attachment.id,
    mediaType: attachment.mediaType,
    name: attachment.fileName,
    width: attachment.width,
    height: attachment.height,
  };
}

/** One authenticated ChatFlow instance; bytes and URLs never enter persistence. */
export function createMessageImageCache() {
  const scopes = new Map<string, SessionBinding & { dispose: () => void }>();
  const dimensions = new Map<
    string,
    Map<string, Pick<Attachment, 'width' | 'height'>>
  >();
  let root = lifetime();
  let native: HistoricalImageCache | undefined;
  const cache = () =>
    (native ??= new HistoricalImageCache(root, {
      binding: (id) => scopes.get(id),
    }));
  const ensure = (scope: string, headers: Record<string, string>) => {
    if (scopes.has(scope)) return;
    const context = lifetime();
    const controller = new AbortController();
    scopes.set(scope, {
      ctx: context,
      dispose: () => {
        controller.abort();
        context.dispose();
      },
      session: {
        async readAttachment(id) {
          const signed = await readJson<{ url: string }>(
            await fetch(`/api/v1/files/${id}/sign`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...headers },
              body: JSON.stringify({ lifetimeSeconds: 900 }),
              signal: controller.signal,
            }),
          );
          const response = await fetch(signed.url, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error('图片加载失败，请重试');
          return {
            ok: true,
            value: {
              attachment: {
                mediaType:
                  response.headers.get('content-type') ??
                  'application/octet-stream',
              },
              data: new Uint8Array(await response.arrayBuffer()),
            },
          };
        },
      },
    });
  };
  return {
    loader(scope: string, headers: Record<string, string>): ImageLoader {
      return Object.assign(
        (attachment: ImageAttachmentRef) => {
          ensure(scope, headers);
          return cache().resolve(scope, attachment);
        },
        {
          peek: (attachment: ImageAttachmentRef) =>
            cache().peek(scope, attachment),
        },
      );
    },
    reference(scope: string, attachment: Attachment) {
      return {
        ...imageReference(attachment),
        ...dimensions.get(scope)?.get(attachment.id),
      };
    },
    handoff(
      scope: string,
      headers: Record<string, string>,
      attachments: Attachment[],
    ) {
      ensure(scope, headers);
      const retained = new Set<string>();
      const sizes = dimensions.get(scope) ?? new Map();
      dimensions.set(scope, sizes);
      for (const attachment of attachments) {
        if (
          !attachment.mediaType.startsWith('image/') ||
          !attachment.previewUrl
        )
          continue;
        sizes.set(attachment.id, {
          width: attachment.width,
          height: attachment.height,
        });
        if (
          cache().seed(scope, imageReference(attachment), attachment.previewUrl)
        )
          retained.add(attachment.previewUrl);
      }
      return retained;
    },
    release(scope: string) {
      scopes.get(scope)?.dispose();
      scopes.delete(scope);
      dimensions.delete(scope);
    },
    dispose() {
      for (const scope of scopes.values()) scope.dispose();
      scopes.clear();
      dimensions.clear();
      root.dispose();
      // React StrictMode can bind the same mounted owner again after cleanup.
      native = undefined;
      root = lifetime();
    },
  };
}

export type MessageImageCache = ReturnType<typeof createMessageImageCache>;

export interface MessageImageSource {
  load: ImageLoader;
  reference: (attachment: Attachment) => ImageAttachmentRef;
}

/** Prepare canonical pixels before the native cache retires a local preview. */
export async function decodeImage(url: string) {
  if (typeof Image === 'undefined') return;
  const image = new Image();
  image.src = url;
  await image.decode();
}
