/** Server-owned rollout policy. Never accept this setting from a request/model.
 * Token accounting is observational for verified Codex subscription routes.
 * Invalid explicit values fail back to enforcement; API billing is unchanged. */
export function codexTokenPolicy(): 'observe' | 'enforce' {
  const value = process.env.ALLRICE_CODEX_TOKEN_POLICY;
  return value === undefined || value === 'observe' ? 'observe' : 'enforce';
}

export function observeCodexTokens(verifiedSubscription: boolean) {
  return verifiedSubscription && codexTokenPolicy() === 'observe';
}
