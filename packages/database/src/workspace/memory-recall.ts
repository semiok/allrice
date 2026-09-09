import { createHash } from 'node:crypto';

import type {
  MemoryClass,
  MemoryLifecycleState,
  MemorySourceType,
  MemoryTrust,
} from '@allrice/contracts';

export interface RankedMemoryRecallCandidate {
  id: string;
  revision?: number;
  content: string;
  sourceType: MemorySourceType;
  sourceId: string | null;
  lifecycleState: MemoryLifecycleState;
  memoryClass: MemoryClass;
  trust: MemoryTrust;
  confidence: number;
  sourceLabel: string;
  capturedAt: string;
  relevanceScore: number;
  updatedAt: string;
}

export function embedWorkspaceText(text: string) {
  const dimensions = 1536;
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [text];
  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    for (let offset = 0; offset < 24; offset += 4) {
      const value = digest.readUInt32BE(offset);
      const index = value % dimensions;
      vector[index] = (vector[index] ?? 0) + (value & 1 ? 1 : -1);
    }
  }
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

export const workspaceMemoryRecallPolicy = {
  automaticThreshold: 0.28,
  explicitThreshold: 0.14,
  maximumAutomaticResults: 3,
  maximumCandidatePool: 240,
  maximumAutomaticTokens: 1_500,
} as const;

function clampRecallScore(value: number) {
  return Math.max(0, Math.min(1, value));
}

function memoryTrustWeight(trust: MemoryTrust) {
  switch (trust) {
    case 'user_confirmed':
      return 1;
    case 'platform_verified':
      return 0.9;
    case 'derived':
      return 0.62;
    case 'untrusted_external':
      return 0.12;
  }
}

function normalizedMemoryContent(content: string) {
  return content.trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
}

function estimatedMemoryTokens(content: string) {
  return Math.max(1, Math.ceil(content.length / 4));
}

export function applyWorkspaceMemoryRecallBudget(
  candidates: RankedMemoryRecallCandidate[],
  maximumTokens: number,
) {
  let remainingTokens = Math.max(0, Math.floor(maximumTokens));
  return candidates.flatMap((candidate) => {
    if (remainingTokens <= 0) return [];
    const estimatedTokens = estimatedMemoryTokens(candidate.content);
    if (estimatedTokens <= remainingTokens) {
      remainingTokens -= estimatedTokens;
      return [candidate];
    }
    const maximumCharacters = remainingTokens * 4;
    if (maximumCharacters < 80) return [];
    remainingTokens = 0;
    return [
      {
        ...candidate,
        content: `${candidate.content.slice(0, Math.max(0, maximumCharacters - 23)).trimEnd()}\n[记忆内容已按预算截断]`,
      },
    ];
  });
}

export function rankWorkspaceMemoryRecallCandidates(
  candidates: Array<{
    id: string;
    revision?: number;
    content: string;
    sourceType: MemorySourceType;
    sourceId: string | null;
    lifecycleState: MemoryLifecycleState;
    memoryClass: MemoryClass;
    trust: MemoryTrust;
    confidence: number;
    sourceLabel: string;
    capturedAt: string;
    updatedAt: string;
    vectorScore: number;
    lexicalScore: number;
  }>,
  options: {
    threshold: number;
    limit: number;
    durableOnly: boolean;
    now?: Date;
  },
): RankedMemoryRecallCandidate[] {
  const now = options.now ?? new Date();
  const ranked = candidates.flatMap((candidate) => {
    if (options.durableOnly && candidate.lifecycleState !== 'durable') {
      return [];
    }
    const vectorScore = clampRecallScore(candidate.vectorScore);
    const lexicalScore = clampRecallScore(candidate.lexicalScore);
    // Trust and freshness may reorder a relevant result, but can never make an
    // irrelevant memory relevant on their own.
    if (Math.max(vectorScore, lexicalScore) < 0.08) return [];
    const ageDays = Math.max(
      0,
      (now.getTime() - new Date(candidate.updatedAt).getTime()) / 86_400_000,
    );
    const freshness = 1 / (1 + ageDays / 90);
    // Either retrieval channel may establish relevance. This matters for
    // names, Chinese phrases and exact project terms where trigram recall is
    // strong even when the deterministic vector representation is weak.
    const relevanceScore =
      Math.max(vectorScore, lexicalScore) * 0.7 +
      Math.min(vectorScore, lexicalScore) * 0.15 +
      memoryTrustWeight(candidate.trust) * candidate.confidence * 0.1 +
      freshness * 0.05;
    if (relevanceScore < options.threshold) return [];
    return [
      {
        id: candidate.id,
        ...(candidate.revision === undefined
          ? {}
          : { revision: candidate.revision }),
        content: candidate.content,
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId,
        lifecycleState: candidate.lifecycleState,
        memoryClass: candidate.memoryClass,
        trust: candidate.trust,
        confidence: candidate.confidence,
        sourceLabel: candidate.sourceLabel,
        capturedAt: candidate.capturedAt,
        relevanceScore,
        updatedAt: candidate.updatedAt,
      },
    ];
  });
  ranked.sort(
    (left, right) =>
      right.relevanceScore - left.relevanceScore ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id),
  );
  const seen = new Set<string>();
  return ranked
    .filter((candidate) => {
      const key = normalizedMemoryContent(candidate.content);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, options.limit);
}
