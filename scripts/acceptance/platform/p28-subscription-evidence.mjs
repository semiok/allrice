// Read-only consistency checks for reviewed, hash-pinned P27 observations.
// This does not authenticate a database, provider, author or execution history.
import { createHash } from 'node:crypto';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, fields) =>
  object(v) &&
  Object.keys(v).length === fields.length &&
  fields.every((field) => Object.hasOwn(v, field));
// PostgreSQL exports UUIDs in lowercase. Require that canonical form so case
// aliases cannot manufacture a second child or a second dispatch of one call.
const uuid = (v) =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    v,
  );
const digest = (v) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const timestamp = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const text = (v, max) =>
  typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= max;
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (object(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** False on missing fields, fabricated N/A markers, digest/identity drift or
 * inconsistent actual-usage totals. Consistent fabricated files still require
 * independent provenance review, just like every other P28 evidence file. */
export function validSubscriptionEvidence(proof, receipt) {
  if (
    !exact(proof, [
      'schema',
      'sourceSha',
      'runId',
      'snapshot',
      'snapshotDigest',
      'route',
      'ledger',
      'result',
      'tree',
      'admissions',
      'priceSnapshotCount',
      'costReceiptCount',
    ]) ||
    proof.schema !== 'allrice-p27-subscription-accounting/v1' ||
    proof.sourceSha !== receipt.sourceSha ||
    proof.runId !== receipt.runId ||
    !uuid(proof.runId) ||
    proof.priceSnapshotCount !== 0 ||
    proof.costReceiptCount !== 0
  )
    return false;
  const s = proof.snapshot;
  if (
    !exact(s, [
      'version',
      'billingMode',
      'harness',
      'provider',
      'authMode',
      'sessionId',
      'employeeId',
      'connectionId',
      'modelCatalogEntryId',
      'policyRevision',
      'model',
      'credentialReference',
      'baseUrl',
      'frozenAt',
    ]) ||
    s.version !== 1 ||
    s.billingMode !== 'subscription' ||
    s.harness !== 'dsh' ||
    s.provider !== 'openai-codex' ||
    s.authMode !== 'chatgpt_subscription' ||
    s.baseUrl !== null ||
    !positive(s.policyRevision) ||
    !text(s.model, 200) ||
    !text(s.credentialReference, 255) ||
    !['sessionId', 'employeeId', 'connectionId', 'modelCatalogEntryId'].every(
      (k) => uuid(s[k]),
    ) ||
    !timestamp(s.frozenAt) ||
    Date.parse(s.frozenAt) > Date.parse(receipt.observedAt) ||
    !digest(proof.snapshotDigest) ||
    `sha256:${createHash('sha256').update(canonical(s)).digest('hex')}` !==
      proof.snapshotDigest
  )
    return false;
  const route = proof.route;
  if (
    !exact(route, [
      'id',
      'organizationId',
      'workspaceId',
      'runId',
      'sessionId',
      'employeeId',
      'connectionId',
      'modelCatalogEntryId',
      'policyRevision',
      'harness',
      'provider',
      'model',
      'status',
      'subscriptionSnapshotDigest',
      'costCents',
      'usageComplete',
      'cacheUsageKnown',
      'inputTokens',
      'outputTokens',
    ]) ||
    !['id', 'organizationId', 'workspaceId'].every((k) => uuid(route[k])) ||
    route.organizationId !== receipt.tenantId ||
    route.runId !== proof.runId ||
    ![
      'sessionId',
      'employeeId',
      'connectionId',
      'modelCatalogEntryId',
      'policyRevision',
      'harness',
      'provider',
      'model',
    ].every((k) => route[k] === s[k]) ||
    route.subscriptionSnapshotDigest !== proof.snapshotDigest ||
    route.status !== 'succeeded' ||
    route.costCents !== null ||
    route.usageComplete !== true ||
    route.cacheUsageKnown !== false ||
    !positive(route.inputTokens) ||
    !positive(route.outputTokens)
  )
    return false;
  const ledger = proof.ledger;
  if (
    !exact(ledger, [
      'routeDecisionId',
      'organizationId',
      'workspaceId',
      'runId',
      'status',
      'costCents',
      'usageComplete',
      'cacheUsageKnown',
      'inputTokens',
      'outputTokens',
    ]) ||
    ledger.routeDecisionId !== route.id ||
    ![
      'organizationId',
      'workspaceId',
      'runId',
      'status',
      'costCents',
      'usageComplete',
      'cacheUsageKnown',
      'inputTokens',
      'outputTokens',
    ].every((k) => ledger[k] === route[k])
  )
    return false;
  const result = proof.result;
  if (
    !exact(result, [
      'provider',
      'model',
      'assistantStatus',
      'billingMode',
      'costBasis',
      'estimatedCostCents',
      'subscriptionSnapshotDigest',
      'costEstimateAvailable',
      'actualCostKnown',
      'usageComplete',
      'cacheUsageKnown',
      'inputTokens',
      'outputTokens',
    ]) ||
    result.provider !== s.provider ||
    result.model !== s.model ||
    result.assistantStatus !== 'completed' ||
    result.billingMode !== 'subscription' ||
    result.costBasis !== 'not_applicable' ||
    result.estimatedCostCents !== null ||
    result.subscriptionSnapshotDigest !== proof.snapshotDigest ||
    result.costEstimateAvailable !== false ||
    result.actualCostKnown !== false ||
    !['usageComplete', 'cacheUsageKnown', 'inputTokens', 'outputTokens'].every(
      (k) => result[k] === route[k],
    )
  )
    return false;
  const tree = proof.tree;
  if (
    !exact(tree, [
      'status',
      'runIds',
      'modelCalls',
      'inputTokens',
      'outputTokens',
      'unsettledUsageCount',
    ]) ||
    tree.status !== 'completed' ||
    !Array.isArray(tree.runIds) ||
    tree.runIds.length !== 3 ||
    !tree.runIds.every(uuid) ||
    new Set(tree.runIds).size !== 3 ||
    !tree.runIds.includes(proof.runId) ||
    tree.unsettledUsageCount !== 0 ||
    tree.inputTokens !== route.inputTokens ||
    tree.outputTokens !== route.outputTokens ||
    !positive(tree.modelCalls) ||
    !Array.isArray(proof.admissions) ||
    proof.admissions.length !== tree.modelCalls ||
    proof.admissions.length > 16
  )
    return false;
  const calls = new Set(),
    runs = new Set();
  let input = 0,
    output = 0;
  for (const call of proof.admissions) {
    if (
      !exact(call, [
        'callId',
        'runId',
        'requestDigest',
        'dispatched',
        'finished',
        'inputTokens',
        'outputTokens',
      ]) ||
      !uuid(call.callId) ||
      calls.has(call.callId) ||
      !tree.runIds.includes(call.runId) ||
      !digest(call.requestDigest) ||
      call.dispatched !== true ||
      call.finished !== true ||
      !positive(call.inputTokens) ||
      !positive(call.outputTokens)
    )
      return false;
    calls.add(call.callId);
    runs.add(call.runId);
    input += call.inputTokens;
    output += call.outputTokens;
  }
  return (
    runs.size === 3 &&
    Number.isSafeInteger(input) &&
    Number.isSafeInteger(output) &&
    input === tree.inputTokens &&
    output === tree.outputTokens
  );
}
