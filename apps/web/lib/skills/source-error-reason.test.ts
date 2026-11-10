import { describe, it, expect } from 'vitest';
import {
  ApiErrorSchema,
  skillSourceErrorHeader,
  SkillSourceErrorReasonSchema,
} from '@allrice/contracts';
import {
  DataAccessError,
  EmployeeContentError,
  PersonalSkillError,
} from '@allrice/database';
import { FileArchiveError } from '@allrice/file-archives';
import {
  PersonalSkillSourceError,
  SkillPreviewError,
} from '@allrice/skill-import';
import { apiProblem } from '../api-problem';
import { addSkillSourceErrorReason } from './source-error-reason';

describe('browser source failure reason preserves the existing error envelope', () => {
  it.each([
    [new SkillPreviewError('name_mismatch'), 'name_mismatch'],
    [new SkillPreviewError('preview_expired'), 'preview_expired'],
    [new PersonalSkillSourceError('source_skill_missing'), 'skill_missing'],
    [
      new PersonalSkillSourceError('upstream_private_detail'),
      'source_unavailable',
    ],
    [new EmployeeContentError('workflow_invalid'), 'workflow_invalid'],
    [new PersonalSkillError('name_conflict'), 'name_conflict'],
    [new PersonalSkillError('limit'), 'limit'],
    [new Error('personal_skill_package_missing_skill'), 'skill_missing'],
    [new FileArchiveError('FILE_ARCHIVE_LIMIT'), 'package_invalid'],
  ] as const)('projects only a stable reason for %s', async (error, reason) => {
    const response = apiProblem({
      status: 422,
      code: 'VALIDATION_FAILED',
      message: 'Existing approved message',
      retryable: false,
    });
    const original = ApiErrorSchema.parse(await response.clone().json());
    expect(addSkillSourceErrorReason(response, error, 'preview')).toBe(
      response,
    );
    expect(
      SkillSourceErrorReasonSchema.parse(
        response.headers.get(skillSourceErrorHeader),
      ),
    ).toBe(reason);
    expect(response.status).toBe(422);
    expect(ApiErrorSchema.parse(await response.json())).toEqual(original);
  });
  it('does not infer authorization or unknown failure from words and keeps confirmation errors distinct', () => {
    for (const error of [
      new DataAccessError('authorization_denied'),
      new FileArchiveError('FILE_ARCHIVE_AUTHORITY_LOST'),
      new FileArchiveError('FILE_ARCHIVE_CANCELED'),
      new PersonalSkillError('unavailable'),
      new Error('name_mismatch source_skill_missing private text'),
      { code: 'name_mismatch' },
      null,
    ]) {
      const response = addSkillSourceErrorReason(
        new Response('', { status: 403 }),
        error,
        'preview',
      );
      expect(response.headers.has(skillSourceErrorHeader)).toBe(false);
    }
    for (const error of [
      new SkillPreviewError('source_invalid'),
      new FileArchiveError('FILE_ARCHIVE_LIMIT'),
    ]) {
      expect(
        addSkillSourceErrorReason(new Response(), error, 'confirm').headers.get(
          skillSourceErrorHeader,
        ),
      ).toBe('preview_invalid');
    }
  });
});
