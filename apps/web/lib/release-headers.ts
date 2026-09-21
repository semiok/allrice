/** Non-secret deployment identity, never a guessed source/worktree revision. */
export function releaseHeaders(): Record<string, string> {
  const sha = process.env.ALLRICE_RELEASE_SHA;
  return /^[a-f0-9]{40}$/.test(sha ?? '')
    ? { 'X-AllRice-Release-Sha': sha! }
    : {};
}
