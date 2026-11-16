export class BrandMediaError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'version_conflict'
      | 'request_conflict'
      | 'invalid_state'
      | 'source_unavailable'
      | 'source_changed'
      | 'source_reference_invalid',
  ) {
    super(code);
  }
}
export function brandMediaFail(code: BrandMediaError['code']): never {
  throw new BrandMediaError(code);
}
