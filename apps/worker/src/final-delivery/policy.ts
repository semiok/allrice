import { createHash } from 'node:crypto';
import { serializeFinalDeliveryFacts } from '@allrice/contracts';

/** Private Worker data. Never deserialize these ports/facts from model or HTTP input. */
export interface DeliveryScope {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  sessionId: string;
  runId: string;
}

export interface ArtifactIdentity {
  objectId: string;
  versionId: string;
  checksum: string;
}

type ArtifactScope = Omit<DeliveryScope, 'runId'>;

export interface DeliveryArtifact extends ArtifactIdentity {
  scope: ArtifactScope;
  originRunId: string | null;
  fileName: string;
  state: 'ready' | 'pending' | 'failed';
  immutable: boolean;
  deletedAt: string | null;
  retentionUntil: string | null;
}

export interface DeliveryCheck extends ArtifactIdentity {
  scope: ArtifactScope;
  originRunId: string | null;
  checkId: string;
  status: 'passed' | 'failed' | 'unavailable' | 'not_checked';
}

export interface DeliveryRequirement {
  /** Server-bound requirement, not a filename/extension inferred from prose. */
  id: string;
  expected: ArtifactIdentity | null;
  source: 'current_run' | 'explicit_reference';
  requireLink: boolean;
  requiredChecks: readonly string[];
  /** Internal technical obligation for an older version only when linked. */
  whenLinked?: true;
}

export interface DeliverySnapshot {
  scope: DeliveryScope;
  /** False on pagination/cap/query failure. A partial list can never certify a reply. */
  complete: boolean;
  /** Means the private reader checked live lease + identity; this flag grants no authority. */
  authorization: 'current';
  now: string;
  /** Derived from the server-owned closed Run tree, never assistant arguments. */
  ownedRunIds: readonly string[];
  /** Old files are readable only when explicitly bound by the trusted request. */
  explicitReferenceVersionIds: readonly string[];
  artifacts: readonly DeliveryArtifact[];
  checks: readonly DeliveryCheck[];
  requirements: readonly DeliveryRequirement[];
  /** Full bound audit receipts, including failures and null/unavailable evidence. */
  qualityReceipts?: readonly unknown[];
}

export interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  value?: string;
  children?: readonly MarkdownNode[];
  position?: { start?: { offset?: number } };
}

export interface HtmlLink {
  href: string;
}

/** Bind a real Markdown AST parser and HTML parser; no regex-only link extraction. */
export interface DeliveryMarkup {
  markdown(text: string): MarkdownNode;
  html(fragment: string): { complete: boolean; links: readonly HtmlLink[] };
}

export type DeliveryIssueCode =
  | 'invalid_delivery_link'
  | 'missing_delivery_link'
  | 'missing_requested_artifact'
  | 'required_check_incomplete'
  | 'empty_response'
  | 'delivery_evidence_incomplete'
  | 'response_unverifiable';

export interface DeliveryIssue {
  code: DeliveryIssueCode;
  reason: string;
  requirementId?: string;
  offset?: number;
  /** Do not place raw/signed URLs in diagnostics. */
  destinationDigest?: string;
}

export interface DeliveryDecision {
  status: 'valid' | 'invalid_response' | 'evidence_unavailable';
  candidateDigest: string;
  factSetDigest: string;
  issues: readonly DeliveryIssue[];
  linked: readonly ArtifactIdentity[];
  /** Capability hint only; phase A never starts a model call. */
  textRepairEligible: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKSUM = /^(?:sha256:)?([0-9a-f]{64})$/i;
const MAX_TEXT_BYTES = 256_000;
const MAX_ARTIFACTS = 1_000;
const MAX_CHECKS = 10_000;
const MAX_REQUIREMENTS = 1_000;
const MAX_NODES = 20_000;
const MAX_LINKS = 1_000;
const MAX_ISSUES = 100;

function hash(value: string): string {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

/** Snapshot arrays are sets of facts; pagination order is not identity. */
function stable(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(stable).sort().join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stable(record[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value) ?? 'null';
}

function normalizedIdentity(value: ArtifactIdentity): ArtifactIdentity | null {
  const checksum = CHECKSUM.exec(value.checksum ?? '');
  if (
    !UUID.test(value.objectId ?? '') ||
    !UUID.test(value.versionId ?? '') ||
    !checksum
  )
    return null;
  return {
    objectId: value.objectId.toLowerCase(),
    versionId: value.versionId.toLowerCase(),
    checksum: 'sha256:' + checksum[1]!.toLowerCase(),
  };
}

function key(identity: ArtifactIdentity): string {
  return identity.objectId + '/' + identity.versionId + '/' + identity.checksum;
}

function sameScope(a: ArtifactScope, b: ArtifactScope): boolean {
  return ['organizationId', 'workspaceId', 'ownerId', 'sessionId'].every(
    (part) =>
      a[part as keyof ArtifactScope]?.toLowerCase() ===
      b[part as keyof ArtifactScope]?.toLowerCase(),
  );
}

function validScope(scope: DeliveryScope): boolean {
  return (
    Object.values(scope).length === 5 &&
    Object.values(scope).every((id) => typeof id === 'string' && UUID.test(id))
  );
}

function validUntil(until: string | null, now: number): boolean {
  return (
    until === null ||
    (Number.isFinite(Date.parse(until)) && Date.parse(until) > now)
  );
}

function referenceId(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

interface CandidateLink {
  href: string;
  offset?: number;
}

function readLinks(text: string, markup: DeliveryMarkup): CandidateLink[] {
  const root = markup.markdown(text);
  if (root.type !== 'root') throw Error('markdown_root_required');
  const definitions = new Map<string, string>();
  const nodes: MarkdownNode[] = [];
  let visited = 0;
  const walk = (node: MarkdownNode): void => {
    if (++visited > MAX_NODES) throw Error('markdown_node_limit');
    // Quoted examples are not delivery claims. Required link slots still need an unquoted link.
    if (['code', 'inlineCode', 'blockquote'].includes(node.type)) return;
    if (node.type === 'definition') {
      const id = referenceId(node.identifier ?? '');
      // Markdown's first definition wins; an unused definition is not a link.
      if (id && typeof node.url === 'string' && !definitions.has(id))
        definitions.set(id, node.url);
      return;
    }
    nodes.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  const links: CandidateLink[] = [];
  for (const node of nodes) {
    const offset = node.position?.start?.offset;
    if (node.type === 'link' || node.type === 'image') {
      if (typeof node.url !== 'string')
        throw Error('markdown_link_url_required');
      links.push({ href: node.url, offset });
    } else if (
      node.type === 'linkReference' ||
      node.type === 'imageReference'
    ) {
      const href = definitions.get(referenceId(node.identifier ?? ''));
      if (href === undefined) throw Error('markdown_reference_unresolved');
      links.push({ href, offset });
    } else if (node.type === 'html') {
      const html = markup.html(node.value ?? '');
      if (!html.complete) throw Error('html_parse_incomplete');
      for (const link of html.links) links.push({ href: link.href, offset });
    }
    if (links.length > MAX_LINKS) throw Error('markdown_link_limit');
  }
  return links;
}

type LinkTarget =
  | { type: 'external' }
  | { type: 'managed'; objectId: string }
  | { type: 'invalid'; reason: string };

function managedTarget(href: string, origins: ReadonlySet<string>): LinkTarget {
  // Match the already-supported separator escaping, but never repair IDs or fullwidth placeholders.
  const escaped = href.replace(/\\+\//g, '/');
  if (/^[／＼]api(?:[／/\\?#]|$)/i.test(escaped))
    return { type: 'invalid', reason: 'noncanonical_managed_path' };
  const sandbox = escaped.startsWith('sandbox:/api/v1/files/')
    ? escaped.slice('sandbox:'.length)
    : escaped;
  let url: URL;
  try {
    url = new URL(sandbox, 'https://managed-link.invalid');
  } catch {
    return /^[/\\／＼]*api(?:[/\\／＼?#]|$)/i.test(sandbox)
      ? { type: 'invalid', reason: 'malformed_managed_url' }
      : { type: 'external' };
  }
  const relative =
    !/^[a-z][a-z0-9+.-]*:/i.test(sandbox) && !sandbox.startsWith('//');
  const ownOrigin = relative || origins.has(url.origin);
  const filePath = /^\/api\/v1\/files(?:\/|$)/i.test(url.pathname);
  const apiPath = /^\/api(?:\/|$)/i.test(url.pathname);
  if (!ownOrigin && !filePath) return { type: 'external' };
  if (!apiPath) return { type: 'external' };
  if (!ownOrigin) return { type: 'invalid', reason: 'foreign_managed_origin' };
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return { type: 'invalid', reason: 'unsupported_managed_url' };
  const match = /^\/api\/v1\/files\/([a-fA-F0-9-]{36})(?:\/download)?$/.exec(
    url.pathname,
  );
  if (!match || !UUID.test(match[1]!))
    return { type: 'invalid', reason: 'managed_object_id_required' };
  if (url.hash)
    return { type: 'invalid', reason: 'unexpected_managed_fragment' };
  // name changes Content-Disposition only. It is deliberately not artifact identity.
  if ([...url.searchParams.keys()].some((name) => name !== 'name'))
    return { type: 'invalid', reason: 'unsupported_managed_query' };
  return { type: 'managed', objectId: match[1]!.toLowerCase() };
}

/**
 * Certifies only deterministic delivery facts, never semantic/business correctness.
 * Pure: no model, network, tool, DB write, text rewrite or artifact publication.
 */
export function checkFinalDelivery(input: {
  candidate: string;
  expectedScope: DeliveryScope;
  snapshot: DeliverySnapshot;
  markup: DeliveryMarkup;
  managedOrigins: readonly string[];
}): DeliveryDecision {
  const { snapshot } = input;
  const candidateDigest = hash(input.candidate);
  let factSetDigest = hash('final-delivery-facts-unavailable/v1');
  let factsSerializable = false;
  try {
    factSetDigest = hash(serializeFinalDeliveryFacts(snapshot));
    factsSerializable = true;
  } catch {
    // Invalid evidence cannot authorize a reply; no empty-facts success fallback.
  }
  const issues: DeliveryIssue[] = [];
  const linked = new Map<string, ArtifactIdentity>();
  let evidenceUnavailable = false;
  const issue = (value: DeliveryIssue, evidence = false): void => {
    evidenceUnavailable ||= evidence;
    if (issues.length >= MAX_ISSUES) {
      evidenceUnavailable = true;
      issues[MAX_ISSUES - 1] = {
        code: 'response_unverifiable',
        reason: 'delivery_issue_limit',
      };
      return;
    }
    issues.push(value);
  };
  const result = (): DeliveryDecision => ({
    status: evidenceUnavailable
      ? 'evidence_unavailable'
      : issues.length
        ? 'invalid_response'
        : 'valid',
    candidateDigest,
    factSetDigest,
    issues,
    linked: [...linked.values()].sort((a, b) => key(a).localeCompare(key(b))),
    textRepairEligible:
      !evidenceUnavailable &&
      issues.length > 0 &&
      issues.every((item) =>
        [
          'invalid_delivery_link',
          'missing_delivery_link',
          'empty_response',
        ].includes(item.code),
      ),
  });

  const now = Date.parse(snapshot.now);
  if (
    !factsSerializable ||
    !validScope(input.expectedScope) ||
    !validScope(snapshot.scope) ||
    !sameScope(input.expectedScope, snapshot.scope) ||
    input.expectedScope.runId.toLowerCase() !==
      snapshot.scope.runId.toLowerCase() ||
    snapshot.authorization !== 'current' ||
    !snapshot.complete ||
    !Number.isFinite(now) ||
    snapshot.artifacts.length > MAX_ARTIFACTS ||
    snapshot.checks.length > MAX_CHECKS ||
    snapshot.requirements.length > MAX_REQUIREMENTS ||
    snapshot.ownedRunIds.length > 200 ||
    snapshot.explicitReferenceVersionIds.length > MAX_ARTIFACTS ||
    !snapshot.ownedRunIds.every((id) => UUID.test(id)) ||
    !snapshot.explicitReferenceVersionIds.every((id) => UUID.test(id)) ||
    !snapshot.ownedRunIds.some(
      (id) => id.toLowerCase() === snapshot.scope.runId.toLowerCase(),
    )
  ) {
    issue(
      {
        code: 'delivery_evidence_incomplete',
        reason: 'snapshot_scope_authority_or_completeness',
      },
      true,
    );
    return result();
  }
  const ownedRuns = new Set(snapshot.ownedRunIds.map((id) => id.toLowerCase()));
  const references = new Set(
    snapshot.explicitReferenceVersionIds.map((id) => id.toLowerCase()),
  );
  const artifacts = new Map<
    string,
    { identity: ArtifactIdentity; artifact: DeliveryArtifact }
  >();
  const byObject = new Map<string, string>();
  const byVersion = new Map<string, string>();
  for (const artifact of snapshot.artifacts) {
    const identity = normalizedIdentity(artifact);
    const allowedOrigin =
      artifact.originRunId !== null &&
      ownedRuns.has(artifact.originRunId.toLowerCase());
    if (
      !identity ||
      !sameScope(artifact.scope, snapshot.scope) ||
      (!allowedOrigin && !references.has(identity.versionId)) ||
      artifact.state !== 'ready' ||
      !artifact.immutable ||
      artifact.deletedAt !== null ||
      !validUntil(artifact.retentionUntil, now) ||
      !artifact.fileName.trim()
    ) {
      issue(
        {
          code: 'delivery_evidence_incomplete',
          reason: 'unavailable_or_unbound_artifact',
        },
        true,
      );
      continue;
    }
    const identityKey = key(identity);
    const prior = artifacts.get(identityKey);
    if (
      (prior && stable(prior.artifact) !== stable(artifact)) ||
      (byObject.has(identity.objectId) &&
        byObject.get(identity.objectId) !== identityKey) ||
      (byVersion.has(identity.versionId) &&
        byVersion.get(identity.versionId) !== identityKey)
    ) {
      issue(
        {
          code: 'delivery_evidence_incomplete',
          reason: 'conflicting_artifact_identity',
        },
        true,
      );
      continue;
    }
    artifacts.set(identityKey, { identity, artifact });
    byObject.set(identity.objectId, identityKey);
    byVersion.set(identity.versionId, identityKey);
  }
  if (evidenceUnavailable) return result();

  try {
    if (!input.candidate.trim())
      issue({ code: 'empty_response', reason: 'empty_candidate' });
    if (Buffer.byteLength(input.candidate, 'utf8') > MAX_TEXT_BYTES)
      throw Error('candidate_byte_limit');
    const origins = new Set(
      input.managedOrigins.map((origin) => {
        const url = new URL(origin);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw Error('managed_origin_invalid');
        return url.origin;
      }),
    );
    for (const link of readLinks(input.candidate, input.markup)) {
      const target = managedTarget(link.href, origins);
      if (target.type === 'external') continue;
      const identityKey =
        target.type === 'managed' ? byObject.get(target.objectId) : undefined;
      if (target.type === 'invalid' || !identityKey) {
        issue({
          code: 'invalid_delivery_link',
          reason:
            target.type === 'invalid'
              ? target.reason
              : 'artifact_not_in_authorized_snapshot',
          offset: link.offset,
          destinationDigest: hash(link.href),
        });
      } else linked.set(identityKey, artifacts.get(identityKey)!.identity);
    }
    const requirementIds = new Set<string>();
    for (const required of snapshot.requirements) {
      if (
        !required.id ||
        requirementIds.has(required.id) ||
        !['current_run', 'explicit_reference'].includes(required.source) ||
        typeof required.requireLink !== 'boolean' ||
        (required.whenLinked !== undefined && required.whenLinked !== true) ||
        (required.whenLinked === true &&
          (required.requireLink || required.source !== 'current_run')) ||
        required.requiredChecks.length > 100 ||
        new Set(required.requiredChecks).size !== required.requiredChecks.length
      ) {
        issue(
          {
            code: 'delivery_evidence_incomplete',
            reason: 'malformed_requirement',
          },
          true,
        );
        continue;
      }
      requirementIds.add(required.id);
      const expected =
        required.expected && normalizedIdentity(required.expected);
      const entry = expected && artifacts.get(key(expected));
      const sourceMatches =
        entry &&
        (required.source === 'current_run'
          ? entry.artifact.originRunId !== null &&
            ownedRuns.has(entry.artifact.originRunId.toLowerCase())
          : references.has(entry.identity.versionId));
      if (!entry || !sourceMatches) {
        issue({
          code: 'missing_requested_artifact',
          reason: 'exact_required_version_not_delivered',
          requirementId: required.id,
        });
        continue;
      }
      if (required.whenLinked === true && !linked.has(key(entry.identity)))
        continue;
      if (required.requireLink && !linked.has(key(entry.identity)))
        issue({
          code: 'missing_delivery_link',
          reason: 'required_version_not_linked',
          requirementId: required.id,
        });
      for (const checkId of required.requiredChecks) {
        const receipts = snapshot.checks.filter((check) => {
          const identity = normalizedIdentity(check);
          return (
            check.checkId === checkId &&
            identity &&
            key(identity) === key(entry.identity) &&
            sameScope(check.scope, snapshot.scope) &&
            check.originRunId?.toLowerCase() ===
              entry.artifact.originRunId?.toLowerCase()
          );
        });
        if (
          !checkId ||
          receipts.length === 0 ||
          receipts.some((check) => check.status !== 'passed')
        )
          issue({
            code: 'required_check_incomplete',
            reason: 'exact_artifact_check_not_passed',
            requirementId: required.id,
          });
      }
    }
  } catch {
    issue(
      { code: 'response_unverifiable', reason: 'markup_or_policy_limit' },
      true,
    );
  }
  return result();
}
