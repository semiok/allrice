import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  reviewedGetLocks,
  reviewedUnresolvedCalls,
  writingGetRoutes,
} from './row-lock-audit.allowlist.ts';
import {
  createRowLockAudit,
  type ReachedLock,
  type RouteLockReport,
} from './row-lock-audit.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * MET-210 #4 gate: SQL reached from an `apps/web/app/api/**` GET handler must
 * not take row locks. Read paths use plain snapshot reads; shared helpers take
 * a `lock` argument that read callers pass as `false`.
 */
describe('GET route handlers take no row locks', () => {
  let report: RouteLockReport;
  beforeAll(() => {
    // Builds the apps/web TypeScript program once: about 5–10 s, ~1 GB.
    report = createRowLockAudit(root).routeLocks(['GET']);
  }, 180_000);
  const writing = new Set(writingGetRoutes.map((entry) => entry.route));
  const reviewed = (site: ReachedLock) =>
    reviewedGetLocks.find(
      (entry) =>
        entry.file === site.file &&
        entry.owner === site.owner &&
        entry.clause === site.clause,
    );

  it('reaches no row-lock clause outside reviewed writing routes', () => {
    const violations = report.reached
      .map((site) => ({
        ...site,
        routes: site.routes.filter(
          (route) => !writing.has(route.replace(/ GET$/, '')),
        ),
      }))
      .filter((site) => site.routes.length && !reviewed(site))
      .map(
        (site) =>
          `${site.file}:${site.line} \`${site.clause}\` in ${site.owner}, from ${site.routes.length} GET route(s):\n    ${site.chain.join('\n    -> ')}`,
      );
    expect(violations).toEqual([]);
  });

  it('follows every interface-typed call on GET paths or has it reviewed', () => {
    const known = new Set(reviewedUnresolvedCalls.map((entry) => entry.target));
    expect(report.unresolved.filter((target) => !known.has(target))).toEqual(
      [],
    );
  });

  it('keeps the allowlists current', () => {
    const routes = new Set(
      report.reached.flatMap((site) =>
        site.routes.map((route) => route.replace(/ GET$/, '')),
      ),
    );
    expect(
      writingGetRoutes.filter((entry) => !routes.has(entry.route)),
    ).toEqual([]);
    expect(
      reviewedGetLocks.filter(
        (entry) =>
          !report.reached.some(
            (site) =>
              site.file === entry.file &&
              site.owner === entry.owner &&
              site.clause === entry.clause,
          ),
      ),
    ).toEqual([]);
    expect(
      reviewedUnresolvedCalls.filter(
        (entry) => !report.unresolved.includes(entry.target),
      ),
    ).toEqual([]);
  });
});
