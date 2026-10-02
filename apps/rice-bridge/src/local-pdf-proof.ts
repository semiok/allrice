import {
  runtimeContractEqual,
  type RuntimeLocalPdfPayload,
  type RuntimeLocalPdfResult,
} from '@allrice/contracts';

/** The result carries the original call and exact source, never just a filename. */
export function pdfResultMatchesPayload(
  payload: RuntimeLocalPdfPayload,
  result: RuntimeLocalPdfResult,
) {
  if (
    !runtimeContractEqual(result.origin, payload.arguments.origin) ||
    !runtimeContractEqual(result.source, payload.arguments.source) ||
    !runtimeContractEqual(result.pins, payload.arguments.pins) ||
    result.profileVersion !== payload.arguments.profileVersion
  )
    return false;
  if (!result.document) return true;
  const expected = payload.arguments.options.pages
    ? [...new Set(payload.arguments.options.pages)].sort((a, b) => a - b)
    : Array.from(
        { length: Math.min(10, result.document.totalPages) },
        (_, i) => i + 1,
      );
  return runtimeContractEqual(result.document.requestedPages, expected);
}
