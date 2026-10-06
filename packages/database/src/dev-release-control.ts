/** Reserved control lane. No release admission exists until the independent
 * supervisor, maintenance barrier and its installed authority are ready. */
export const devReleaseJobType = 'allrice.platform.dev.release' as const;

export function isDevReleaseControlType(type: unknown) {
  return typeof type === 'string' && type.startsWith('allrice.platform.dev.');
}
