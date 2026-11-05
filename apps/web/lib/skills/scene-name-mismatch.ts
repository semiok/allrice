import { SkillPreviewError } from '@allrice/skill-import';

/** Names come from the parsed source and the currently authorized scene. */
export class SceneNameMismatchError extends SkillPreviewError {
  constructor(
    readonly incomingName: string,
    readonly currentSceneName: string,
  ) {
    super('name_mismatch');
  }
}
