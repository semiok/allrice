import { describe, expect, it } from 'vitest';

import { capabilityChecksum as canonicalCapabilityChecksum } from './capabilities/capability-registry.ts';
import { connectorInputDigest as canonicalConnectorInputDigest } from './capabilities/connector-broker.ts';
import { capabilityChecksum as legacyCapabilityChecksum } from './capability-registry.ts';
import { parseChatFlowWakeup as parseCanonicalWakeup } from './conversation/notifications.ts';
import { contextCheckpointChecksum as canonicalCheckpointChecksum } from './conversation/conversation-checkpoint.ts';
import { decideConversationDelivery as canonicalDeliveryDecision } from './conversation/conversation-input.ts';
import { conversationRuntimeCanAcquire as canonicalCanAcquire } from './conversation/conversation-runtime.ts';
import { contextCheckpointChecksum as legacyCheckpointChecksum } from './conversation-checkpoint.ts';
import { decideConversationDelivery as legacyDeliveryDecision } from './conversation-input.ts';
import { conversationRuntimeCanAcquire as legacyCanAcquire } from './conversation-runtime.ts';
import { conversationUsageWatermark as canonicalUsageWatermark } from './conversation/usage.ts';
import { parseChatFlowWakeup as parseLegacyWakeup } from './chatflow-notifications.ts';
import { conversationUsageWatermark as legacyUsageWatermark } from './conversation-usage.ts';
import { connectorInputDigest as legacyConnectorInputDigest } from './connector-broker.ts';
import { applyEmployeeUserProfilePolicy as canonicalUserProfilePolicy } from './employees/employee-config.ts';
import { evaluateEmployeeReleaseGate as canonicalReleaseGate } from './employees/employee-quality.ts';
import { nativeSkillCapabilityGrants as canonicalSkillGrants } from './employees/employeehub.ts';
import { listPlatformEmployees as canonicalListPlatformEmployees } from './employees/platform-employees.ts';
import { applyEmployeeUserProfilePolicy as legacyUserProfilePolicy } from './employee-config.ts';
import { evaluateEmployeeReleaseGate as legacyReleaseGate } from './employee-quality.ts';
import { nativeSkillCapabilityGrants as legacySkillGrants } from './employeehub.ts';
import { workflowDigest as canonicalWorkflowDigest } from './execution/workflow-runtime.ts';
import { workflowDigest as legacyWorkflowDigest } from './workflow-runtime.ts';
import { embedKnowledgeText as canonicalEmbedKnowledgeText } from './memory/knowledge-retrieval.ts';
import { embedKnowledgeText as legacyEmbedKnowledgeText } from './knowledge-retrieval.ts';
import { replaceWorkerDshRuntimeInventory as replaceCanonicalInventory } from './providers/dsh-runtime-registry.ts';
import { recordCodexProviderStatus as recordCanonicalProviderStatus } from './providers/status.ts';
import { replaceWorkerDshRuntimeInventory as replaceLegacyInventory } from './dsh-runtime-registry.ts';
import { listPlatformEmployees as legacyListPlatformEmployees } from './platform-employees.ts';
import { recordCodexProviderStatus as recordLegacyProviderStatus } from './provider-status.ts';
import { ensureDefaultEmployee as canonicalEnsureDefaultEmployee } from './workspace/service.ts';
import { ensureDefaultEmployee as legacyEnsureDefaultEmployee } from './workspace.ts';

describe('database domain compatibility facades', () => {
  it('keeps conversation root paths as identity-preserving re-exports', () => {
    expect(parseLegacyWakeup).toBe(parseCanonicalWakeup);
    expect(legacyUsageWatermark).toBe(canonicalUsageWatermark);
  });

  it('keeps provider root paths as identity-preserving re-exports', () => {
    expect(recordLegacyProviderStatus).toBe(recordCanonicalProviderStatus);
    expect(replaceLegacyInventory).toBe(replaceCanonicalInventory);
  });

  it('keeps capability and connector root paths as compatibility facades', () => {
    expect(legacyCapabilityChecksum).toBe(canonicalCapabilityChecksum);
    expect(legacyConnectorInputDigest).toBe(canonicalConnectorInputDigest);
  });

  it('keeps conversation service root paths as compatibility facades', () => {
    expect(legacyCheckpointChecksum).toBe(canonicalCheckpointChecksum);
    expect(legacyDeliveryDecision).toBe(canonicalDeliveryDecision);
    expect(legacyCanAcquire).toBe(canonicalCanAcquire);
  });

  it('keeps employee root paths as compatibility facades', () => {
    expect(legacyUserProfilePolicy).toBe(canonicalUserProfilePolicy);
    expect(legacyReleaseGate).toBe(canonicalReleaseGate);
    expect(legacySkillGrants).toBe(canonicalSkillGrants);
    expect(legacyListPlatformEmployees).toBe(canonicalListPlatformEmployees);
  });

  it('keeps memory, workflow, and workspace root paths compatible', () => {
    expect(legacyEmbedKnowledgeText).toBe(canonicalEmbedKnowledgeText);
    expect(legacyWorkflowDigest).toBe(canonicalWorkflowDigest);
    expect(legacyEnsureDefaultEmployee).toBe(canonicalEnsureDefaultEmployee);
  });
});
