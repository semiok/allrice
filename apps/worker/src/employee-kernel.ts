import {
  EmployeeKernelRequestSchema,
  type ContextCheckpoint,
  type EmployeeKernelRequest,
} from '@allrice/contracts';
import type { resolveEmployeeExecution } from '@allrice/database';

type ResolvedEmployeeExecution = Awaited<
  ReturnType<typeof resolveEmployeeExecution>
>;

type KernelConversationMessage =
  ResolvedEmployeeExecution['promptSnapshot']['conversation'][number];

export function bootstrapConversationForCheckpoint(
  messages: KernelConversationMessage[],
  checkpoint?: ContextCheckpoint | null,
) {
  const coveredIndex = checkpoint?.coveredThroughMessageId
    ? messages.findIndex(
        (message) => message.id === checkpoint.coveredThroughMessageId,
      )
    : -1;
  const recentMessages =
    coveredIndex >= 0 ? messages.slice(coveredIndex + 1) : messages;
  const conversation = recentMessages
    .map((message) => `${message.role}: ${message.text}`)
    .join('\n');
  return checkpoint
    ? [
        `AllRice durable context checkpoint (${checkpoint.summaryVersion}, generation ${checkpoint.generation}):`,
        checkpoint.summary,
        conversation
          ? `Recent conversation after checkpoint:\n${conversation}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    : conversation;
}

export function assembleEmployeeKernel(input: {
  employeeAssignmentId: string;
  employeeVersionId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  resolved: ResolvedEmployeeExecution;
  checkpoint?: ContextCheckpoint | null;
}): EmployeeKernelRequest {
  const bootstrapConversation = bootstrapConversationForCheckpoint(
    input.resolved.promptSnapshot.conversation,
    input.checkpoint,
  );
  const memories = input.resolved.promptSnapshot.memories
    .map((memory) => `- [${memory.id}] ${memory.content}`)
    .join('\n');
  // Durable v1/v2 snapshots may still say `codex`, but new execution has one
  // production harness only. Codex subscription access is a DSH Provider.
  const runtimeHarness = 'dsh';
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
    bootstrapConversation,
    authorizedMemoryContext: memories
      ? `Authorized memory snapshot:\n${memories}`
      : '',
    grantedCapabilities: input.resolved.grantedCapabilities,
    skillVersionIds: input.resolved.nativeSkills.map((skill) => skill.id),
    imageAttachments: input.resolved.promptSnapshot.imageAttachments,
  });
}
