import { describe, it, expect } from 'vitest';
import { repositoryRequiredChecks } from '@allrice/database/technical-contracts';
import { strictRepositoryMergePolicy } from './merge-policy.js';
const policy = () => ({
  required_status_checks: {
    strict: true,
    checks: repositoryRequiredChecks.map((context) => ({
      context,
      app_id: 15368,
    })),
  },
  enforce_admins: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
});
describe('remote merge base guard', () => {
  it('requires strict current-base CI enforced for administrators from the real GitHub Actions app', () => {
    expect(strictRepositoryMergePolicy(policy()).kind).toBe(
      'strict_protected_main',
    );
    for (const change of [
      null,
      {},
      { ...policy(), enforce_admins: { enabled: false } },
      { ...policy(), allow_force_pushes: { enabled: true } },
      { ...policy(), allow_deletions: { enabled: true } },
      { ...policy(), allow_force_pushes: undefined },
      { ...policy(), allow_deletions: undefined },
      {
        ...policy(),
        required_status_checks: {
          strict: false,
          checks: policy().required_status_checks.checks,
        },
      },
      {
        ...policy(),
        required_status_checks: {
          strict: true,
          checks: policy().required_status_checks.checks.map((c) => ({
            ...c,
            app_id: null,
          })),
        },
      },
      {
        ...policy(),
        required_status_checks: {
          strict: true,
          checks: policy().required_status_checks.checks.slice(1),
        },
      },
    ])
      expect(() => strictRepositoryMergePolicy(change)).toThrow(
        'REPOSITORY_BASE_PROTECTION_REQUIRED',
      );
  });
});
