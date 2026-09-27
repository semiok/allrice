/** Compatibility field for existing console clients. The execution-wide
 * observation policy replaces the former subscription-only rollout switch. */
export function codexTokenPolicy(): 'observe' | 'enforce' {
  return 'observe';
}
