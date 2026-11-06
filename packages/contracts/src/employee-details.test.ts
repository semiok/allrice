import { describe, expect, it } from 'vitest';
import { EmployeeDetailsProfileSchema } from './employee-details.ts';

const tenantSource = {
  kind: 'tenant_version',
  employeeVersionId: '10000000-0000-4000-8000-000000000001',
};
const platformSource = {
  kind: 'platform',
  employeeVersionId: tenantSource.employeeVersionId,
  templateId: '10000000-0000-4000-8000-000000000002',
  templateRevisionId: '10000000-0000-4000-8000-000000000003',
  templateRevision: 3,
  templateChecksum: `sha256:${'a'.repeat(64)}`,
};
const legacy = {
  instanceId: '10000000-0000-4000-8000-000000000004',
  kind: 'custom',
  revision: 1,
  source: tenantSource,
  name: 'Synthetic employee',
  description: 'Authorized tenant display',
  appearance: { avatarType: 'emoji', avatarValue: '🍚' },
  identity: {
    role: 'Partner',
    mission: 'Read the authorized evidence',
    workStyle: 'Return exact facts',
    behaviorRules: [],
    safetyBoundaries: [],
  },
  personalFields: [],
  canMaintainPersonal: true,
  defaults: { mission: 'Original partial display baseline' },
};

describe('employee detail defaults and raw overrides contract', () => {
  it('reads an older DTO without inserting source, override or expression defaults', () => {
    const parsed = EmployeeDetailsProfileSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(parsed).not.toHaveProperty('defaultSource');
    expect(parsed).not.toHaveProperty('overrides');
    expect(parsed).not.toHaveProperty('expressionStyle');
    expect(parsed.defaults).not.toHaveProperty('expressionStyle');
  });

  it('preserves sparse leaves and explicit same-value overrides rather than inferring ownership from values', () => {
    const projection = EmployeeDetailsProfileSchema.parse({
      ...legacy,
      expressionStyle: 'structured',
      defaults: {
        expressionStyle: 'structured',
        appearance: { accentColor: 'green' },
      },
      overrides: {
        expressionStyle: 'structured',
        appearance: { accentColor: 'blue' },
      },
      personalFields: ['expressionStyle', 'appearance'],
      defaultSource: platformSource,
    });
    expect(projection.overrides).toEqual({
      expressionStyle: 'structured',
      appearance: { accentColor: 'blue' },
    });
    expect(projection.defaults).toEqual({
      expressionStyle: 'structured',
      appearance: { accentColor: 'green' },
    });
    expect(projection.defaultSource).toEqual(platformSource);
  });

  it('represents actual tenant provenance and unconfirmed platform defaults without relabeling the existing source', () => {
    expect(
      EmployeeDetailsProfileSchema.parse({
        ...legacy,
        overrides: {},
        defaultSource: tenantSource,
      }).defaultSource,
    ).toEqual(tenantSource);
    const unconfirmed = EmployeeDetailsProfileSchema.parse({
      ...legacy,
      source: platformSource,
      overrides: {},
    });
    expect(unconfirmed.source).toEqual(platformSource);
    expect(unconfirmed).not.toHaveProperty('defaultSource');
  });

  it.each(['concise', 'structured', 'exploratory'])(
    'retains exact expression mode %s in all three views',
    (expressionStyle) => {
      expect(
        EmployeeDetailsProfileSchema.parse({
          ...legacy,
          expressionStyle,
          defaults: { expressionStyle },
          overrides: { expressionStyle },
        }),
      ).toMatchObject({
        expressionStyle,
        defaults: { expressionStyle },
        overrides: { expressionStyle },
      });
    },
  );

  it.each([
    { expressionStyle: 'free text' },
    { defaults: { expressionStyle: 'free text' } },
    { overrides: { expressionStyle: 'free text' } },
    { overrides: { toolNames: ['secret.read'] } },
    { defaultSource: { ...platformSource, templateChecksum: 'invalid' } },
    { defaultSource: null },
    { defaults: null },
  ])(
    'rejects malformed additions without loosening old detail fields: %j',
    (change) => {
      expect(
        EmployeeDetailsProfileSchema.safeParse({ ...legacy, ...change })
          .success,
      ).toBe(false);
    },
  );
});
