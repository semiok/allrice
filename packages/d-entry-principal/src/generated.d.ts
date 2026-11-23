// The official generator writes both public contributions in the same build.
// These interfaces describe that boundary without importing an old build.
declare module '#principal-artifacts' {
  import type { TypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol';

  export const TYPERT: unknown;
  export const TYPERT_REMOTE: TypertRemoteInfo;
}
