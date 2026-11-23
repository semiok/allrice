// The official generator writes both public contributions in the same build.
// These interfaces describe that boundary without importing an old build.
declare module '#principal-artifacts' {
  export const TYPERT: unknown;
  export const TYPERT_REMOTE: import('@deepseek-ai/dsh-typert-protocol').TypertRemoteInfo;
}
