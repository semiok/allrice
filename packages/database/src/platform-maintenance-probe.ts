/** Public synthetic input, never installation/business secrets. The collector's
 * verdict is an installation claim until central source verification repeats it. */
export const maintenanceProbeFixtures = Object.freeze([
  {
    id: 'quoted_spaces' as const,
    chunks: ['password="allrice-probe-alpha allrice-probe-beta"\n'],
    forbidden: ['allrice-probe-alpha', 'allrice-probe-beta'],
  },
  {
    id: 'quoted_escapes' as const,
    chunks: ['{"secret":"allrice-probe-alpha\\"allrice-probe-beta"}\n'],
    forbidden: ['allrice-probe-alpha', 'allrice-probe-beta'],
  },
  {
    id: 'streamed_secret' as const,
    chunks: ['secret="allrice-probe-', 'alpha allrice-probe-beta"\n'],
    forbidden: ['allrice-probe-alpha', 'allrice-probe-beta'],
  },
]);
