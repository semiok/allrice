import type { RuntimeLocalCommand } from '@allrice/contracts';
/** Source/installer inputs only. Execution authority and lifecycle stay in each backend. */
export type ProjectRuntimeArguments = Pick<
  RuntimeLocalCommand['arguments'],
  | 'executable'
  | 'args'
  | 'path'
  | 'files'
  | 'imageDigest'
  | 'limits'
  | 'projectPreparation'
  | 'projectSource'
  | 'outputs'
>;
export type ProjectRuntimeCommand = { arguments: ProjectRuntimeArguments };
export interface ProjectEngine {
  json<T>(method: string, path: string, body?: unknown): Promise<T>;
}
