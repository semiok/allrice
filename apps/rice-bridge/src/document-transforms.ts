import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setImmediate as yieldTask } from 'node:timers/promises';
import { imageSize } from 'image-size';
import {
  degrees,
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFStream,
  type PDFObject,
} from 'pdf-lib';
import { loadFixedPdfResources } from './local-pdf-resources.js';

export const documentTransformMaximumFileBytes = 9_000_000;
export const documentTransformMaximumTotalBytes = 128_000_000;
export const documentTransformMaximumFiles = 32;
export const documentTransformMaximumPdfPages = 500;
export const documentTransformMaximumImagePixels = 16_000_000;
export const documentTransformMaximumTotalImagePixels = 64_000_000;
export const documentTransformMaximumImageDimension = 8192;

export type DocumentTransformSource = { path: string; bytes: Uint8Array };
export type DocumentImageFormat = 'png' | 'jpeg' | 'webp';
export type DocumentTransformRequest =
  | { kind: 'pdf_merge'; name: string }
  | { kind: 'pdf_extract'; name: string; pages: readonly number[] }
  | {
      kind: 'pdf_rotate';
      name: string;
      degrees: 90 | 180 | 270;
      pages?: readonly number[];
    }
  | {
      kind: 'image_resize';
      width: number;
      height: number;
      format?: DocumentImageFormat;
      quality?: number;
    }
  | {
      kind: 'image_format';
      format: DocumentImageFormat;
      quality?: number;
    };
export type DocumentTransformControls = {
  signal?: AbortSignal;
  authorize?: () => Promise<boolean>;
};
export type DocumentTransformResult = {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
};
type ErrorCode =
  | 'DOCUMENT_TRANSFORM_INVALID_REQUEST'
  | 'DOCUMENT_TRANSFORM_INVALID_SOURCE'
  | 'DOCUMENT_TRANSFORM_UNSAFE_PATH'
  | 'DOCUMENT_TRANSFORM_NAME_CONFLICT'
  | 'DOCUMENT_TRANSFORM_LIMIT'
  | 'DOCUMENT_TRANSFORM_PDF_ENCRYPTED'
  | 'DOCUMENT_TRANSFORM_PDF_UNSUPPORTED'
  | 'DOCUMENT_TRANSFORM_IMAGE_UNSUPPORTED'
  | 'DOCUMENT_TRANSFORM_RUNTIME_UNAVAILABLE'
  | 'DOCUMENT_TRANSFORM_CANCELED'
  | 'DOCUMENT_TRANSFORM_AUTHORITY_LOST';

export class DocumentTransformError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
function fail(code: ErrorCode): never {
  throw new DocumentTransformError(code);
}
function checkSignal(controls: DocumentTransformControls) {
  if (controls.signal?.aborted) fail('DOCUMENT_TRANSFORM_CANCELED');
}
async function checkpoint(controls: DocumentTransformControls) {
  checkSignal(controls);
  if (controls.authorize) {
    let removeAbort = () => {};
    try {
      const abort = new Promise<never>((_, reject) => {
        const signal = controls.signal;
        if (!signal) return;
        const onAbort = () =>
          reject(new DocumentTransformError('DOCUMENT_TRANSFORM_CANCELED'));
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) onAbort();
      });
      const allowed = await Promise.race([
        Promise.resolve()
          .then(() => controls.authorize!())
          .catch(() => false),
        abort,
      ]);
      checkSignal(controls);
      if (!allowed) fail('DOCUMENT_TRANSFORM_AUTHORITY_LOST');
    } finally {
      removeAbort();
    }
  }
  await yieldTask();
  checkSignal(controls);
}

function safePath(path: string, fileName = false) {
  if (
    typeof path !== 'string' ||
    !path ||
    Buffer.byteLength(path, 'utf8') > 1024 ||
    /[\\:]/u.test(path) ||
    (fileName && path.includes('/'))
  )
    fail('DOCUMENT_TRANSFORM_UNSAFE_PATH');
  for (const character of path) {
    const code = character.codePointAt(0)!;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      fail('DOCUMENT_TRANSFORM_UNSAFE_PATH');
  }
  for (const segment of path.split('/')) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.trim() !== segment
    )
      fail('DOCUMENT_TRANSFORM_UNSAFE_PATH');
  }
  return path;
}
const nameKey = (name: string) => name.normalize('NFC').toLowerCase();
function checkedBytes(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
    fail('DOCUMENT_TRANSFORM_INVALID_SOURCE');
  if (bytes.byteLength > documentTransformMaximumFileBytes)
    fail('DOCUMENT_TRANSFORM_LIMIT');
}
function checkedPixels(width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  )
    fail('DOCUMENT_TRANSFORM_INVALID_REQUEST');
  if (
    width > documentTransformMaximumImageDimension ||
    height > documentTransformMaximumImageDimension ||
    width * height > documentTransformMaximumImagePixels
  )
    fail('DOCUMENT_TRANSFORM_LIMIT');
  return width * height;
}
function checkedPages(pages: readonly number[], count: number) {
  if (
    !Array.isArray(pages) ||
    pages.length === 0 ||
    pages.length > documentTransformMaximumPdfPages ||
    new Set(pages).size !== pages.length ||
    pages.some(
      (page) => !Number.isSafeInteger(page) || page < 1 || page > count,
    )
  )
    fail('DOCUMENT_TRANSFORM_INVALID_REQUEST');
  // Extraction order is intentional. Do not sort the caller's page list.
  return pages.map((page) => page - 1);
}

function supportedPdf(document: PDFDocument) {
  if (document.isEncrypted) fail('DOCUMENT_TRANSFORM_PDF_ENCRYPTED');
  if (
    document.catalog.has(PDFName.of('AcroForm')) ||
    document.catalog.has(PDFName.of('Perms'))
  )
    fail('DOCUMENT_TRANSFORM_PDF_UNSUPPORTED');
  // Inspect the mature parser's object graph, including direct dictionaries:
  // page assembly cannot promise to retain forms or any digital signature.
  const stack: { object: PDFObject; depth: number }[] = document.context
    .enumerateIndirectObjects()
    .map(([, object]) => ({ object, depth: 0 }));
  const seen = new Set<PDFObject>();
  while (stack.length) {
    const { object, depth } = stack.pop()!;
    if (seen.has(object)) continue;
    seen.add(object);
    if (seen.size > 100_000 || depth > 64) fail('DOCUMENT_TRANSFORM_LIMIT');
    const dictionary = object instanceof PDFStream ? object.dict : object;
    if (dictionary instanceof PDFDict) {
      if (
        dictionary.has(PDFName.of('ByteRange')) ||
        dictionary.has(PDFName.of('AcroForm')) ||
        dictionary.has(PDFName.of('XFA')) ||
        dictionary.get(PDFName.of('Subtype')) === PDFName.of('Widget') ||
        dictionary.get(PDFName.of('Type')) === PDFName.of('Sig') ||
        dictionary.get(PDFName.of('FT')) === PDFName.of('Sig')
      )
        fail('DOCUMENT_TRANSFORM_PDF_UNSUPPORTED');
      for (const value of dictionary.values())
        stack.push({ object: value, depth: depth + 1 });
    } else if (object instanceof PDFArray) {
      for (let index = 0; index < object.size(); index++)
        stack.push({ object: object.get(index), depth: depth + 1 });
    }
  }
}

async function transformPdf(
  sources: readonly DocumentTransformSource[],
  request: Extract<DocumentTransformRequest, { name: string }>,
  controls: DocumentTransformControls,
): Promise<DocumentTransformResult[]> {
  const name = safePath(request.name, true);
  if (!name.toLowerCase().endsWith('.pdf'))
    fail('DOCUMENT_TRANSFORM_INVALID_REQUEST');
  if (request.kind !== 'pdf_merge' && sources.length !== 1)
    fail('DOCUMENT_TRANSFORM_INVALID_REQUEST');
  if (
    request.kind === 'pdf_rotate' &&
    ![90, 180, 270].includes(request.degrees)
  )
    fail('DOCUMENT_TRANSFORM_INVALID_REQUEST');
  const documents: PDFDocument[] = [];
  let totalPages = 0;
  for (const source of sources) {
    await checkpoint(controls);
    let document: PDFDocument;
    try {
      document = await PDFDocument.load(source.bytes, {
        ignoreEncryption: false,
        throwOnInvalidObject: true,
        updateMetadata: false,
        parseSpeed: 100,
      });
      supportedPdf(document);
      const count = document.getPageCount();
      if (!Number.isSafeInteger(count) || count < 1)
        fail('DOCUMENT_TRANSFORM_INVALID_SOURCE');
      totalPages += count;
      if (totalPages > documentTransformMaximumPdfPages)
        fail('DOCUMENT_TRANSFORM_LIMIT');
    } catch (error) {
      if (error instanceof DocumentTransformError) throw error;
      // pdf-lib 1.17.1's ES5 Error subclasses do not retain their prototype
      // under Node. Match only this exported, fixed library error message too.
      if (
        error instanceof EncryptedPDFError ||
        (error instanceof Error &&
          error.message === new EncryptedPDFError().message)
      )
        fail('DOCUMENT_TRANSFORM_PDF_ENCRYPTED');
      fail('DOCUMENT_TRANSFORM_INVALID_SOURCE');
    }
    await checkpoint(controls);
    documents.push(document);
  }
  try {
    const output =
      request.kind === 'pdf_rotate'
        ? documents[0]!
        : await PDFDocument.create({ updateMetadata: false });
    if (request.kind === 'pdf_rotate') {
      const indexes = request.pages
        ? checkedPages(request.pages, output.getPageCount())
        : output.getPageIndices();
      for (const index of indexes) {
        await checkpoint(controls);
        const page = output.getPage(index);
        const angle = page.getRotation().angle;
        if (!Number.isSafeInteger(angle) || angle % 90 !== 0)
          fail('DOCUMENT_TRANSFORM_PDF_UNSUPPORTED');
        page.setRotation(
          degrees((((angle + request.degrees) % 360) + 360) % 360),
        );
      }
    } else {
      for (const document of documents) {
        const indexes =
          request.kind === 'pdf_extract'
            ? checkedPages(request.pages, document.getPageCount())
            : document.getPageIndices();
        // A single mature copier per document preserves shared font/image
        // resources, instead of duplicating them once per copied page.
        await checkpoint(controls);
        const pages = await output.copyPages(document, indexes);
        for (const page of pages) {
          await checkpoint(controls);
          output.addPage(page);
        }
      }
    }
    await checkpoint(controls);
    const bytes = await output.save({
      objectsPerTick: 50,
      addDefaultPage: false,
      updateFieldAppearances: false,
    });
    await checkpoint(controls);
    checkedBytes(bytes);
    return [{ name, mediaType: 'application/pdf', bytes }];
  } catch (error) {
    if (error instanceof DocumentTransformError) throw error;
    fail('DOCUMENT_TRANSFORM_INVALID_SOURCE');
  }
}

// Deliberately use the already sealed and hash-checked PDF sidecar. A normal
// host node_modules native addon is never a production fallback.
interface FixedImage {
  width: number;
  height: number;
}
interface FixedCanvas {
  width: number;
  height: number;
  getContext(
    kind: '2d',
    options: { colorSpace: 'srgb' },
  ): {
    fillStyle: string;
    fillRect(x: number, y: number, width: number, height: number): void;
    drawImage(
      image: FixedImage,
      x: number,
      y: number,
      width: number,
      height: number,
    ): void;
    imageSmoothingEnabled: boolean;
    imageSmoothingQuality: string;
  };
  encodeStream(
    format: DocumentImageFormat,
    quality?: number,
  ): ReadableStream<Uint8Array>;
}
interface FixedCanvasLibrary {
  loadImage(bytes: Uint8Array): Promise<FixedImage>;
  createCanvas(width: number, height: number): FixedCanvas;
}
function fixedCanvas(): FixedCanvasLibrary {
  try {
    // The fixed native package must not be replaced by an inherited addon or
    // WASI override. Check before the PDF loader itself imports Canvas too.
    if (
      process.env.NAPI_RS_NATIVE_LIBRARY_PATH ||
      process.env.NAPI_RS_FORCE_WASI
    )
      fail('DOCUMENT_TRANSFORM_RUNTIME_UNAVAILABLE');
    const { root } = loadFixedPdfResources();
    const entry = join(root, 'node_modules/@napi-rs/canvas/index.js');
    return createRequire(entry)(entry) as FixedCanvasLibrary;
  } catch {
    fail('DOCUMENT_TRANSFORM_RUNTIME_UNAVAILABLE');
  }
}

function imageMetadata(bytes: Uint8Array): {
  width: number;
  height: number;
  format: DocumentImageFormat;
  orientation: number | undefined;
} {
  try {
    const metadata = imageSize(bytes);
    const format = metadata.type === 'jpg' ? 'jpeg' : metadata.type;
    if (format !== 'png' && format !== 'jpeg' && format !== 'webp')
      fail('DOCUMENT_TRANSFORM_IMAGE_UNSUPPORTED');
    const { width, height } = metadata;
    if (width === undefined || height === undefined)
      fail('DOCUMENT_TRANSFORM_INVALID_SOURCE');
    checkedPixels(width, height);
    return { width, height, format, orientation: metadata.orientation };
  } catch (error) {
    if (error instanceof DocumentTransformError) throw error;
    fail('DOCUMENT_TRANSFORM_INVALID_SOURCE');
  }
}

async function encodedImage(
  canvas: FixedCanvas,
  format: DocumentImageFormat,
  quality: number,
  controls: DocumentTransformControls,
) {
  const reader = canvas.encodeStream(format, quality).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => void reader.cancel().catch(() => {});
  controls.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      await checkpoint(controls);
      const { value, done } = await reader.read();
      checkSignal(controls);
      if (done) break;
      size += value.byteLength;
      if (size > documentTransformMaximumFileBytes)
        fail('DOCUMENT_TRANSFORM_LIMIT');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    controls.signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function transformImages(
  sources: readonly DocumentTransformSource[],
  request: Extract<
    DocumentTransformRequest,
    { kind: 'image_resize' | 'image_format' }
  >,
  controls: DocumentTransformControls,
): Promise<DocumentTransformResult[]> {
  if (
    (request.format !== undefined &&
      !['png', 'jpeg', 'webp'].includes(request.format)) ||
    (request.kind === 'image_format' && request.format === undefined) ||
    (request.quality !== undefined &&
      (!Number.isSafeInteger(request.quality) ||
        request.quality < 1 ||
        request.quality > 100))
  )
    fail('DOCUMENT_TRANSFORM_INVALID_REQUEST');
  if (request.kind === 'image_resize')
    checkedPixels(request.width, request.height);
  // Validate every source before loading a native decoder. image-size parses
  // encoded dimensions, rather than trusting paths or allocating raw pixels.
  const metadata = sources.map((source) => imageMetadata(source.bytes));
  const inputPixels = metadata.reduce(
    (sum, value) => sum + value.width * value.height,
    0,
  );
  const outputPixels = metadata.reduce(
    (sum, value) =>
      sum +
      (request.kind === 'image_resize'
        ? request.width * request.height
        : value.width * value.height),
    0,
  );
  if (
    inputPixels > documentTransformMaximumTotalImagePixels ||
    outputPixels > documentTransformMaximumTotalImagePixels
  )
    fail('DOCUMENT_TRANSFORM_LIMIT');
  const names = sources.map((source, index) => {
    const base = source.path.split('/').at(-1)!;
    const stem = base.includes('.')
      ? base.slice(0, base.lastIndexOf('.'))
      : base;
    return safePath(
      `${stem || 'image'}.${request.format ?? metadata[index]!.format}`,
      true,
    );
  });
  if (new Set(names.map(nameKey)).size !== names.length)
    fail('DOCUMENT_TRANSFORM_NAME_CONFLICT');
  await checkpoint(controls);
  const library = fixedCanvas();
  const result: DocumentTransformResult[] = [];
  let totalBytes = 0;
  for (const [index, source] of sources.entries()) {
    await checkpoint(controls);
    const expected = metadata[index]!;
    try {
      // Buffer only: the library's URL/path loaders are never reachable here.
      // Skia applies EXIF orientation; pixels are re-encoded without EXIF.
      const image = await library.loadImage(source.bytes);
      await checkpoint(controls);
      checkedPixels(image.width, image.height);
      const swap =
        expected.orientation !== undefined &&
        expected.orientation >= 5 &&
        expected.orientation <= 8;
      if (
        image.width !== (swap ? expected.height : expected.width) ||
        image.height !== (swap ? expected.width : expected.height)
      )
        fail('DOCUMENT_TRANSFORM_INVALID_SOURCE');
      const width =
        request.kind === 'image_resize' ? request.width : image.width;
      const height =
        request.kind === 'image_resize' ? request.height : image.height;
      const format = request.format ?? expected.format;
      const canvas = library.createCanvas(width, height);
      try {
        const context = canvas.getContext('2d', { colorSpace: 'srgb' });
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        if (format === 'jpeg') {
          // JPEG has no alpha channel. Flatten transparency onto white.
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, width, height);
        }
        context.drawImage(image, 0, 0, width, height);
        await checkpoint(controls);
        const bytes = await encodedImage(
          canvas,
          format,
          request.quality ?? 85,
          controls,
        );
        await checkpoint(controls);
        checkedBytes(bytes);
        const encoded = imageMetadata(bytes);
        if (
          encoded.format !== format ||
          encoded.width !== width ||
          encoded.height !== height
        )
          fail('DOCUMENT_TRANSFORM_INVALID_SOURCE');
        totalBytes += bytes.byteLength;
        if (totalBytes > documentTransformMaximumTotalBytes)
          fail('DOCUMENT_TRANSFORM_LIMIT');
        result.push({
          name: names[index]!,
          mediaType: `image/${format}`,
          bytes,
        });
      } finally {
        // Release the native drawing surface before the next batch member.
        canvas.width = 1;
        canvas.height = 1;
      }
    } catch (error) {
      if (error instanceof DocumentTransformError) throw error;
      fail('DOCUMENT_TRANSFORM_INVALID_SOURCE');
    }
  }
  return result;
}

/**
 * Byte-only page assembly and raster re-encoding. No source path is opened.
 * Image resize uses exact dimensions; animated images become the first frame.
 * PNG/WebP keep alpha, JPEG uses white; metadata/ICC/animation are not retained.
 * Caller supervision is required for physical cancellation/RSS bounds during
 * native decode/encode or a library operation. Checkpoints prevent delivery
 * after cancellation/revocation; promises alone do not prove physical stop.
 */
export async function transformDocuments(
  sources: readonly DocumentTransformSource[],
  request: DocumentTransformRequest,
  controls: DocumentTransformControls = {},
): Promise<DocumentTransformResult[]> {
  await checkpoint(controls);
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    sources.length > documentTransformMaximumFiles
  )
    fail('DOCUMENT_TRANSFORM_LIMIT');
  if (!request || typeof request !== 'object')
    fail('DOCUMENT_TRANSFORM_INVALID_REQUEST');
  const paths = new Set<string>();
  let totalBytes = 0;
  const checkedSources: DocumentTransformSource[] = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object')
      fail('DOCUMENT_TRANSFORM_INVALID_SOURCE');
    const path = safePath(source.path);
    const key = nameKey(path);
    if (paths.has(key)) fail('DOCUMENT_TRANSFORM_NAME_CONFLICT');
    paths.add(key);
    checkedBytes(source.bytes);
    totalBytes += source.bytes.byteLength;
    if (totalBytes > documentTransformMaximumTotalBytes)
      fail('DOCUMENT_TRANSFORM_LIMIT');
    checkedSources.push({ path, bytes: source.bytes });
  }
  // Validate the entire batch before copying it or invoking a decoder.
  // Copy without yielding between validation and snapshotting caller views.
  const fixedSources = checkedSources.map(({ path, bytes }) => ({
    path,
    bytes: Uint8Array.from(bytes),
  }));
  let result: DocumentTransformResult[];
  switch (request.kind) {
    case 'pdf_merge':
    case 'pdf_extract':
    case 'pdf_rotate':
      result = await transformPdf(fixedSources, request, controls);
      break;
    case 'image_resize':
    case 'image_format':
      result = await transformImages(fixedSources, request, controls);
      break;
    default:
      fail('DOCUMENT_TRANSFORM_INVALID_REQUEST');
  }
  await checkpoint(controls);
  return result;
}
