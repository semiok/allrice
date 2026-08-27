import {
  RouteCandidateSchema,
  RouteRequestSchema,
  type EmployeeExecutionSnapshot,
  type RouteCandidate,
  type RouteKind,
  type RouteReasonCode,
  type RouteRequest,
  type SkillCapability,
} from '@allrice/contracts';

interface ToolRouteDefinition {
  name: string;
  description: string;
  requiredCapability: SkillCapability;
}

interface CandidateFacts {
  candidate: RouteCandidate;
  terms: string[];
  explicitTerms: string[];
}

export interface CapabilityRoutePlan {
  candidates: RouteCandidate[];
  selectedKind: RouteKind;
  selectedCandidateId: string;
  reasonCodes: RouteReasonCode[];
  selectedSkillVersionIds: string[];
  selectedKnowledgeRevisionIds: string[];
  selectedWorkflowRevisionIds: string[];
  selectedToolNames: string[];
}

const familyTerms: Record<RouteKind, string[]> = {
  direct: [],
  knowledge: [
    '知识库',
    '资料库',
    '根据文档',
    '查资料',
    'knowledge',
    'document base',
  ],
  agent_skill: ['技能', 'skill', '专项能力'],
  workflow: ['工作流', 'workflow', '按流程', '流程执行'],
  tool: ['调用工具', '使用工具', 'tool'],
};

const kindPriority: Record<RouteKind, number> = {
  direct: 0,
  knowledge: 1,
  agent_skill: 2,
  tool: 3,
  workflow: 4,
};

function normalize(value: string) {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function containsTerm(prompt: string, term: string) {
  const normalized = normalize(term);
  return normalized.length >= 2 && prompt.includes(normalized);
}

function scoreCandidate(prompt: string, facts: CandidateFacts) {
  let score = facts.candidate.kind === 'direct' ? 1 : 0;
  const explicit = facts.explicitTerms.some((term) =>
    containsTerm(prompt, term),
  );
  const named = facts.terms.some((term) => containsTerm(prompt, term));
  if (explicit) score += 100;
  if (named) score += 50;
  return { score, explicit, named };
}

function authorization(input: {
  effective: boolean;
  aclAllowed?: boolean;
  connectorAllowed?: boolean;
  requiredCapabilities: SkillCapability[];
  grantedCapabilities: SkillCapability[];
  requiresApproval: boolean;
  approvalPolicy: 'confirm_side_effects' | 'confirm_external' | 'autonomous';
  approvalHandledByWorkflow?: boolean;
}): Pick<RouteCandidate, 'authorized' | 'exclusionReason'> {
  if (!input.effective) {
    return { authorized: false, exclusionReason: 'excluded_not_effective' };
  }
  if (input.aclAllowed === false) {
    return { authorized: false, exclusionReason: 'excluded_acl_denied' };
  }
  if (input.connectorAllowed === false) {
    return {
      authorized: false,
      exclusionReason: 'excluded_connector_identity',
    };
  }
  if (
    !input.requiredCapabilities.every((capability) =>
      input.grantedCapabilities.includes(capability),
    )
  ) {
    return {
      authorized: false,
      exclusionReason: 'excluded_capability_denied',
    };
  }
  if (
    input.requiresApproval &&
    !input.approvalHandledByWorkflow &&
    input.approvalPolicy !== 'autonomous'
  ) {
    return {
      authorized: false,
      exclusionReason: 'excluded_approval_required',
    };
  }
  return { authorized: true, exclusionReason: null };
}

function workflowCapabilities(
  definition: Extract<
    EmployeeExecutionSnapshot,
    { schemaVersion: 2 }
  >['capabilitySnapshot']['workflows'][number]['revision']['definition'],
) {
  const required: SkillCapability[] = [];
  for (const step of definition.steps) {
    if (step.kind === 'model' || step.kind === 'agent_skill') {
      required.push('model:invoke');
    } else if (step.kind === 'knowledge') {
      required.push('storage:read');
    } else if (step.kind === 'tool') {
      const capability = step.input.requiredCapability;
      if (typeof capability === 'string') {
        const parsed = [
          'network:outbound',
          'storage:read',
          'storage:write',
          'secret:use',
          'model:invoke',
          'automation:write',
        ].find((candidate) => candidate === capability) as
          SkillCapability | undefined;
        if (parsed) required.push(parsed);
      }
    }
  }
  return unique(required);
}

function toolTerms(name: string, description: string) {
  const specific: Record<string, string[]> = {
    'workspace.file.list': ['文件', '文档', '列出文件', 'list files'],
    'workspace.file.read': ['读取文件', '打开文件', 'read file'],
    'workspace.memory.search': ['记忆', '以前说过', 'memory'],
    'workspace.session.search': ['历史对话', '之前的对话', 'conversation'],
    'automation.create': ['提醒', '定时', '稍后', 'remind', 'schedule'],
  };
  return [name, description, ...(specific[name] ?? [])];
}

export function decideCapabilityRoute(input: {
  request: RouteRequest;
  executionSnapshot: EmployeeExecutionSnapshot | null;
  tools: readonly ToolRouteDefinition[];
}): CapabilityRoutePlan {
  const request = RouteRequestSchema.parse(input.request);
  const prompt = normalize(request.prompt);
  const snapshot = input.executionSnapshot;
  if (
    snapshot &&
    (snapshot.tenantContext.organizationId !== request.organizationId ||
      snapshot.tenantContext.workspaceId !== request.workspaceId ||
      snapshot.tenantContext.actorId !== request.actorId ||
      snapshot.employee.id !== request.employeeId)
  ) {
    throw new Error('Route request does not match the frozen tenant snapshot');
  }
  const grantedCapabilities = snapshot?.capabilitySnapshot
    .grantedCapabilities ?? ['model:invoke'];
  const approvalPolicy =
    snapshot?.employee.definition.schemaVersion === 2
      ? snapshot.employee.definition.securityPolicy.approvalPolicy
      : 'confirm_side_effects';
  const facts: CandidateFacts[] = [];
  const directAuth = authorization({
    effective: true,
    requiredCapabilities: ['model:invoke'],
    grantedCapabilities,
    requiresApproval: false,
    approvalPolicy,
  });
  facts.push({
    candidate: RouteCandidateSchema.parse({
      id: 'direct',
      kind: 'direct',
      name: '直接回答',
      bindingId: null,
      requiredCapabilities: ['model:invoke'],
      risk: 'low',
      requiresApproval: false,
      ...directAuth,
      score: 1,
    }),
    terms: [],
    explicitTerms: [],
  });
  if (snapshot?.schemaVersion === 2) {
    for (const binding of snapshot.capabilitySnapshot.knowledge) {
      const requiredCapabilities: SkillCapability[] = ['storage:read'];
      const connectorAllowed =
        binding.revision.definition.sourceKind !== 'connector' ||
        snapshot.employee.definition.schemaVersion !== 2 ||
        snapshot.employee.definition.securityPolicy.connectorIdentityModes
          .length > 0;
      facts.push({
        candidate: RouteCandidateSchema.parse({
          id: `knowledge:${binding.revision.id}`,
          kind: 'knowledge',
          name: binding.revision.name,
          bindingId: binding.bindingId,
          requiredCapabilities,
          risk: 'low',
          requiresApproval: false,
          ...authorization({
            effective: binding.effective,
            aclAllowed: binding.effectiveAcl.length > 0,
            connectorAllowed,
            requiredCapabilities,
            grantedCapabilities,
            requiresApproval: false,
            approvalPolicy,
          }),
          score: 0,
        }),
        terms: [
          binding.revision.name,
          binding.revision.slug,
          binding.revision.description,
        ],
        explicitTerms: familyTerms.knowledge,
      });
    }
    for (const binding of snapshot.capabilitySnapshot.agentSkills) {
      const requiredCapabilities = unique(binding.grantedCapabilities);
      const risk = binding.revision.metadata.riskLevel;
      const requiresApproval =
        risk === 'high' ||
        risk === 'critical' ||
        requiredCapabilities.some((capability) =>
          ['storage:write', 'secret:use', 'automation:write'].includes(
            capability,
          ),
        );
      facts.push({
        candidate: RouteCandidateSchema.parse({
          id: `agent_skill:${binding.revision.id}`,
          kind: 'agent_skill',
          name: binding.revision.name,
          bindingId: binding.bindingId,
          requiredCapabilities,
          risk,
          requiresApproval,
          ...authorization({
            effective: binding.effective,
            requiredCapabilities,
            grantedCapabilities,
            requiresApproval,
            approvalPolicy,
          }),
          score: 0,
        }),
        terms: [
          binding.revision.name,
          binding.revision.slug,
          binding.revision.description,
          ...binding.revision.metadata.applicableScenarios,
        ],
        explicitTerms: familyTerms.agent_skill,
      });
    }
    for (const binding of snapshot.capabilitySnapshot.workflows) {
      const requiredCapabilities = workflowCapabilities(
        binding.revision.definition,
      );
      const requiresApproval = binding.revision.definition.steps.some(
        (step) => step.approval === 'required',
      );
      facts.push({
        candidate: RouteCandidateSchema.parse({
          id: `workflow:${binding.revision.id}`,
          kind: 'workflow',
          name: binding.revision.name,
          bindingId: binding.bindingId,
          requiredCapabilities,
          risk: requiresApproval ? 'high' : 'medium',
          requiresApproval,
          ...authorization({
            effective: binding.effective,
            requiredCapabilities,
            grantedCapabilities,
            requiresApproval,
            approvalPolicy,
            approvalHandledByWorkflow: true,
          }),
          score: 0,
        }),
        terms: [
          binding.revision.name,
          binding.revision.slug,
          binding.revision.description,
        ],
        explicitTerms: familyTerms.workflow,
      });
    }
  }
  for (const tool of input.tools) {
    const requiresApproval = [
      'storage:write',
      'secret:use',
      'automation:write',
    ].includes(tool.requiredCapability);
    facts.push({
      candidate: RouteCandidateSchema.parse({
        id: `tool:${tool.name}`,
        kind: 'tool',
        name: tool.name,
        bindingId: null,
        requiredCapabilities: [tool.requiredCapability],
        risk: requiresApproval ? 'high' : 'low',
        requiresApproval,
        ...authorization({
          effective: true,
          requiredCapabilities: [tool.requiredCapability],
          grantedCapabilities,
          requiresApproval,
          approvalPolicy,
        }),
        score: 0,
      }),
      terms: toolTerms(tool.name, tool.description),
      explicitTerms: [tool.name, ...familyTerms.tool],
    });
  }
  let matchedExplicitIntent = false;
  let matchedName = false;
  const candidates = facts.map((entry) => {
    const score = scoreCandidate(prompt, entry);
    matchedExplicitIntent ||= score.explicit;
    matchedName ||= score.named;
    return RouteCandidateSchema.parse({
      ...entry.candidate,
      score: score.score,
    });
  });
  const requestedKinds = unique(
    (Object.entries(familyTerms) as [RouteKind, string[]][])
      .filter(([kind, terms]) =>
        kind === 'direct'
          ? false
          : terms.some((term) => containsTerm(prompt, term)),
      )
      .map(([kind]) => kind),
  );
  const authorized = candidates
    .filter((candidate) => candidate.authorized)
    .sort(
      (left, right) =>
        right.score - left.score ||
        kindPriority[left.kind] - kindPriority[right.kind] ||
        left.id.localeCompare(right.id),
    );
  const best = authorized[0];
  if (!best) {
    throw new Error('No authorized route can invoke the employee model');
  }
  let selected = best.score > 1 ? best : candidates[0]!;
  const matchedKnowledge = authorized.filter(
    (candidate) => candidate.kind === 'knowledge' && candidate.score > 1,
  );
  const matchedSkills = authorized.filter(
    (candidate) => candidate.kind === 'agent_skill' && candidate.score > 1,
  );
  if (matchedKnowledge.length > 0 && matchedSkills.length > 0) {
    selected = matchedSkills[0]!;
  }
  const reasonCodes: RouteReasonCode[] = [];
  if (selected.kind === 'direct') {
    reasonCodes.push(
      requestedKinds.length > 0
        ? 'fallback_no_authorized_candidate'
        : 'direct_no_capability_match',
    );
  } else {
    if (matchedExplicitIntent) reasonCodes.push('matched_explicit_intent');
    if (matchedName) reasonCodes.push('matched_name_or_scenario');
    reasonCodes.push('minimum_necessary_capability');
  }
  const tied = authorized.filter(
    (candidate) => candidate.score === selected.score && candidate.score > 1,
  );
  if (tied.length > 1) reasonCodes.push('ambiguous_deterministic_tiebreak');
  const revisionId = selected.id.split(':').slice(1).join(':');
  return {
    candidates,
    selectedKind: selected.kind,
    selectedCandidateId: selected.id,
    reasonCodes: unique(reasonCodes),
    selectedSkillVersionIds:
      selected.kind === 'agent_skill' ? [revisionId] : [],
    selectedKnowledgeRevisionIds:
      selected.kind === 'knowledge'
        ? [revisionId]
        : selected.kind === 'agent_skill'
          ? matchedKnowledge
              .slice(0, 3)
              .map((candidate) => candidate.id.split(':').slice(1).join(':'))
          : [],
    selectedWorkflowRevisionIds:
      selected.kind === 'workflow' ? [revisionId] : [],
    selectedToolNames: selected.kind === 'tool' ? [revisionId] : [],
  };
}
