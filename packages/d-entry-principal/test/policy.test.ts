import { describe, expect, it } from 'vitest';
import { projectSessions } from '../src/policy.js';
import { DEntryPrincipalIssueSchema } from '../src/types.js';
import { issue, summary } from './host-fixture.js';

describe('native resource projection is bounded by the original root and access', () => {
  it('projects actual descendant ancestry, never a sibling, missing parent or cyclic browser-selected root', () => {
    const selected = issue('execute');
    const rows = [
      summary('root'),
      summary('child', 'root'),
      summary('grandchild', 'child'),
      summary('other'),
      summary('orphan', 'absent'),
      summary('cycle-a', 'cycle-b'),
      summary('cycle-b', 'cycle-a'),
    ];
    const values = projectSessions(selected, rows);
    expect(
      values
        .filter((binding) => binding.role.actions.includes('session/page'))
        .map((binding) => binding.resource),
    ).toEqual([
      { kind: 'session', id: 'root' },
      { kind: 'session', id: 'child' },
      { kind: 'session', id: 'grandchild' },
    ]);
    expect(
      values
        .filter((binding) => binding.role.actions.includes('session/prompt'))
        .map((binding) => binding.resource),
    ).toEqual([{ kind: 'session', id: 'root' }]);
    expect(
      values.some(
        (binding) =>
          binding.resource.kind === 'global' ||
          binding.role.actions.some((action) => action.startsWith('event:')),
      ),
    ).toBe(false);
  });
  it('history/read projection cannot imply send, VM ownership, global list or control authority', () => {
    const values = projectSessions(issue('history'), [
      summary('root'),
      summary('child', 'root'),
    ]);
    for (const action of ['session/prompt', 'session/list', 'session/control'])
      expect(values.flatMap((binding) => binding.role.actions)).not.toContain(
        action,
      );
    expect(values).toHaveLength(2);
  });
  it('rejects duplicate IDs, a child selected as root and a root missing from the real catalog', () => {
    expect(() =>
      projectSessions(issue(), [summary('root'), summary('root')]),
    ).toThrow('PRINCIPAL_CATALOG_INVALID');
    expect(() =>
      projectSessions(issue(), [summary('root', 'another')]),
    ).toThrow('PRINCIPAL_ROOT_INVALID');
    expect(() => projectSessions(issue(), [summary('another')])).toThrow(
      'PRINCIPAL_ROOT_INVALID',
    );
  });
  it('retains the original UUID/identity strict contract rather than accepting grants or a client principal', () => {
    const selected = issue();
    expect(() =>
      DEntryPrincipalIssueSchema.parse({ ...selected, grants: [] }),
    ).toThrow();
    expect(() =>
      DEntryPrincipalIssueSchema.parse({
        ...selected,
        identity: { ...selected.identity, owner: true },
      }),
    ).toThrow();
    expect(() =>
      DEntryPrincipalIssueSchema.parse({
        ...selected,
        scopeId: 'opaque-browser-scope',
      }),
    ).toThrow();
  });
});
