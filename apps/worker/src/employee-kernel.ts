import {
  EmployeeKernelRequestSchema,
  type EmployeeKernelRequest,
} from '@allrice/contracts';
import type { resolveEmployeeExecution } from '@allrice/database';

type ResolvedEmployeeExecution = Awaited<
  ReturnType<typeof resolveEmployeeExecution>
>;

export function assembleEmployeeKernel(input: {
  employeeAssignmentId: string;
  employeeVersionId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  resolved: ResolvedEmployeeExecution;
}): EmployeeKernelRequest {
  const conversation = input.resolved.promptSnapshot.conversation
    .map((message) => `${message.role}: ${message.text}`)
    .join('\n');
  const memories = input.resolved.promptSnapshot.memories
    .map((memory) => `- [${memory.id}] ${memory.content}`)
    .join('\n');
  const runtimeHarness =
    input.resolved.executionSnapshot?.runtimePolicy.harness ?? 'codex';
  return EmployeeKernelRequestSchema.parse({
    schemaVersion: 1,
    harness: runtimeHarness,
    employeeAssignmentId: input.employeeAssignmentId,
    employeeVersionId: input.employeeVersionId,
    sessionId: input.sessionId,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    systemInstructions: input.resolved.promptSnapshot.systemPrompt,
    userRequest: input.resolved.promptSnapshot.userRequest,
    bootstrapConversation: conversation,
    authorizedMemoryContext: memories
      ? `Authorized memory snapshot:\n${memories}`
      : '',
    grantedCapabilities: input.resolved.grantedCapabilities,
    skillVersionIds: input.resolved.skillArtifacts.map(
      (artifact) => artifact.skillVersionId,
    ),
  });
}
