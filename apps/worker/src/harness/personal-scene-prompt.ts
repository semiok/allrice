/** Private Worker transport, not a model/browser authorization contract. */
export interface PersonalScenePromptSource {
  /** Exact kernel input captured alongside the database source check. */
  kernelUserRequest: string;
  /** Absent for internal producers, even when their SQL role is user. */
  humanText?: string;
}
export interface PersonalScenePromptPart {
  kind: 'user' | 'allrice-context';
  text: string;
}

/** Preserve every byte while separating server-added context from a verified
 * current message. This compares framing, never parses intent or slash syntax. */
export function personalScenePromptParts(
  context: string,
  userRequest: string,
  source: PersonalScenePromptSource | undefined,
): PersonalScenePromptPart[] {
  const parts: PersonalScenePromptPart[] = [];
  if (context) parts.push({ kind: 'allrice-context', text: context });
  const human = source?.humanText;
  if (!human || source?.kernelUserRequest !== userRequest) {
    if (userRequest) parts.push({ kind: 'allrice-context', text: userRequest });
    return parts;
  }
  if (userRequest !== human && !userRequest.startsWith(`${human}\n\n`))
    throw Error('employee_scene_human_source_mismatch');
  parts.push({ kind: 'user', text: human });
  const suffix = userRequest.slice(human.length + 2);
  if (suffix) parts.push({ kind: 'allrice-context', text: suffix });
  return parts;
}
