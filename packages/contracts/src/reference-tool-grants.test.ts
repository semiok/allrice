import { describe, expect, it } from 'vitest';
import {
  freezeReferenceToolNames,
  referenceToolNames,
} from './reference-tool-grants.ts';
import { EmployeeCapabilityBindingsSchema } from './employees.ts';

describe('R3 ordinary Run qualification', () => {
  it('derives both references only from an existing storage/file reader without expanding historical or delegated names', () => {
    const names = ['workspace.file.read'];
    expect(
      freezeReferenceToolNames(names, ['storage:read'], undefined, true),
    ).toEqual([...names, ...referenceToolNames]);
    for (const ordinary of [true, false]) {
      expect(freezeReferenceToolNames(names, [], undefined, ordinary)).toEqual(
        names,
      );
      expect(
        freezeReferenceToolNames(
          ['workspace.skill.read'],
          ['storage:read'],
          undefined,
          ordinary,
        ),
      ).toEqual(['workspace.skill.read']);
    }
    expect(
      freezeReferenceToolNames(names, ['storage:read'], undefined, false),
    ).toEqual(names);
    expect(names).toEqual(['workspace.file.read']);
  });
  it('never displaces a frozen tool or overflows the existing tool limit', () => {
    const names = ['workspace.file.read'];
    while (
      EmployeeCapabilityBindingsSchema.shape.toolNames.safeParse([
        ...names,
        'tool-' + names.length,
      ]).success
    )
      names.push('tool-' + names.length);
    expect(
      freezeReferenceToolNames(names, ['storage:read'], undefined, true),
    ).toEqual(names);
  });
});
