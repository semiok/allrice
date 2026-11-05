import { personalSkillLimits } from '@allrice/contracts';
import { SkillPreviewError } from '@allrice/skill-import';

async function boundedBody(request: Request, limit: number) {
  const declared = request.headers.get('content-length');
  if (
    declared !== null &&
    (!Number.isSafeInteger(Number(declared)) || Number(declared) > limit)
  )
    throw new SkillPreviewError('source_invalid');
  const reader = request.body?.getReader();
  if (!reader) throw new SkillPreviewError('source_invalid');
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new SkillPreviewError('source_invalid');
      parts.push(next.value);
    }
    return Buffer.concat(parts, length);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Confirmation carries the previously bounded ZIP in a signed base64url
 * payload. Reject oversized requests before JSON allocation. */
export async function readSkillConfirmationRequest(request: Request) {
  if (
    request.headers.get('content-type')?.split(';', 1)[0]?.trim() !==
    'application/json'
  )
    throw new SkillPreviewError('preview_invalid');
  const bytes = await boundedBody(
    request,
    Math.ceil((personalSkillLimits.archiveBytes * 4) / 3) + 65_536,
  );
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError)
      throw new SkillPreviewError('preview_invalid');
    throw error;
  }
}

/** Bound the body before JSON/formData allocation; neither Content-Length nor
 * the multipart filename is an authority or a filesystem path. */
export async function readSkillPreviewRequest(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.split(';', 1)[0]?.trim() === 'application/json') {
    const bytes = await boundedBody(request, 16_384);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof TypeError)
        throw new SkillPreviewError('source_invalid');
      throw error;
    }
    return {
      input: JSON.parse(text),
    };
  }
  if (contentType.split(';', 1)[0]?.trim() !== 'multipart/form-data')
    throw new SkillPreviewError('source_invalid');
  const bytes = await boundedBody(
    request,
    personalSkillLimits.archiveBytes + 65_536,
  );
  let form: FormData;
  try {
    // The body is already bounded and buffered: TypeError here is malformed
    // multipart syntax, not a failure while reading the client's stream.
    form = await new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: bytes,
    }).formData();
  } catch (error) {
    if (error instanceof TypeError)
      throw new SkillPreviewError('source_invalid');
    throw error;
  }
  if (
    form.getAll('input').length !== 1 ||
    form.getAll('file').length !== 1 ||
    [...form.keys()].some((key) => key !== 'input' && key !== 'file')
  )
    throw new SkillPreviewError('source_invalid');
  const raw = form.get('input');
  const file = form.get('file');
  if (
    typeof raw !== 'string' ||
    Buffer.byteLength(raw) > 16_384 ||
    typeof file === 'string' ||
    !file ||
    file.size > personalSkillLimits.archiveBytes
  )
    throw new SkillPreviewError('source_invalid');
  const input: unknown = JSON.parse(raw);
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    'source' in input
  )
    throw new SkillPreviewError('source_invalid');
  return {
    input: { ...input, source: { kind: 'zip', fileName: file.name } },
    archive: new Uint8Array(await file.arrayBuffer()),
  };
}
