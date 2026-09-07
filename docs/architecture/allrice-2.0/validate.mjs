// P00 material checks only: no product API, database, processes or network.
import assert from 'node:assert/strict';
import { log } from 'node:console';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
const read = (path) => readFileSync(resolve(directory, path), 'utf8');
const data = JSON.parse(read('fixtures/p00-contract-cases.json'));
const sha = (text) =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
let assertions = 0;
let localLinks = 0;
function check(condition, message) {
  assertions += 1;
  assert.ok(condition, message);
}
function equal(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

equal(data.fixtureFormat, 'allrice-p00-design-cases-v1', 'fixture format');
equal(
  data.validationStatus,
  'design_only_not_executed',
  'material is not runtime evidence',
);
check(Number.isFinite(Date.parse(data.fixedNow)), 'fixed time is parseable');
equal(data.cases.length, 13, 'intentional P00 scenario inventory');
equal(
  new Set(data.cases.map((entry) => entry.id)).size,
  data.cases.length,
  'unique cases',
);

const contracts = new Set();
const gaLines = new Set();
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
for (const [name, scope] of Object.entries(data.scopes)) {
  for (const field of [
    'organizationId',
    'workspaceId',
    'projectId',
    'actorId',
    'sessionId',
    'runId',
  ]) {
    check(uuid.test(scope[field]), `${name}.${field} is a synthetic UUID`);
  }
  check(Boolean(data.sources[scope.sourceRef]), `${name} source exists`);
}
check(
  data.scopes.tenantA.organizationId !== data.scopes.tenantB.organizationId,
  'tenant fixtures differ',
);
for (const [name, source] of Object.entries(data.sources)) {
  check(Boolean(data.scopes[source.scopeRef]), `${name} scope exists`);
}
for (const [name, artifact] of Object.entries(data.artifacts)) {
  check(
    Boolean(data.scopes[artifact.scopeRef]),
    `${name} artifact scope exists`,
  );
  check(
    Boolean(data.sources[artifact.sourceRef]),
    `${name} artifact source exists`,
  );
  check(
    uuid.test(artifact.artifactId) && uuid.test(artifact.seriesId),
    `${name} stable identity`,
  );
  equal(
    artifact.checksum,
    sha(artifact.content),
    `${name} UTF-8 content checksum`,
  );
  check(
    Number.isInteger(artifact.version) && artifact.version > 0,
    `${name} content version`,
  );
}

// Validate nested design references, not any production schema.
function inspectReferences(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /(?:scopeRef|ScopeRef)$/.test(key)) {
      check(Boolean(data.scopes[item]), `${key}: ${item}`);
    } else if (
      typeof item === 'string' &&
      /(?:artifactRef|ArtifactRef)$/.test(key)
    ) {
      check(Boolean(data.artifacts[item]), `${key}: ${item}`);
    } else if (typeof item === 'string' && key === 'sourceRef') {
      check(Boolean(data.sources[item]), `${key}: ${item}`);
    } else if (
      Array.isArray(item) &&
      /(?:artifactRefs|ArtifactRefs|sourceRefs|SourceRefs)$/.test(key)
    ) {
      const registry = /[aA]rtifact/.test(key) ? data.artifacts : data.sources;
      item.forEach((ref) => check(Boolean(registry[ref]), `${key}: ${ref}`));
    }
    inspectReferences(item);
  }
}
for (const entry of data.cases) {
  equal(
    entry.validationStatus,
    'design_only_not_executed',
    `${entry.id} remains design-only`,
  );
  check(
    entry.steps.length > 0 && Object.keys(entry.expected).length > 0,
    `${entry.id} has steps and expectations`,
  );
  entry.contracts.forEach((id) => {
    check(/^C[1-8]$/.test(id), `${entry.id} contract ${id}`);
    contracts.add(id);
  });
  entry.gaLines.forEach((id) => gaLines.add(id));
  entry.candidatePrs.forEach((id) => {
    check(
      /^P(?:0[0-9]|1[0-9]|2[0-8])(?:-[abc])?$/.test(id),
      `${entry.id} candidate ${id}`,
    );
    check(!['P03', 'P09'].includes(id), `${entry.id} uses split candidates`);
  });
  inspectReferences(entry);
}
equal(
  [...contracts].sort(),
  ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'],
  'eight contracts',
);
equal(
  [...gaLines].sort(),
  ['base_subagents', 'browser', 'cloud_business', 'local_project'],
  'four GA lines',
);

const cases = Object.fromEntries(data.cases.map((entry) => [entry.id, entry]));
equal(
  cases.A08.futureSemanticNotes.fork.scope,
  'future_only_not_GA',
  'fork stays deferred',
);
equal(
  cases.A08.futureSemanticNotes.fork.implementationCandidate,
  null,
  'fork has no GA implementation candidate',
);
equal(
  cases.A08.futureSemanticNotes.fork.enableEntryForGA,
  false,
  'fork entry not enabled by P00',
);
check(
  !cases.A08.steps.some((step) => /fork/i.test(step)),
  'fork is not a GA test step',
);
const reconcile = cases.A09;
const orders = new Map(
  reconcile.input.orders.map((row) => [row.orderId, row.amount]),
);
const settlements = new Map(
  reconcile.input.settlements.map((row) => [row.orderId, row.amount]),
);
const rows = [...new Set([...orders.keys(), ...settlements.keys()])]
  .sort()
  .map((orderId) => {
    const orderAmount = orders.get(orderId) ?? null;
    const settlementAmount = settlements.get(orderId) ?? null;
    const delta =
      orderAmount === null || settlementAmount === null
        ? null
        : orderAmount - settlementAmount;
    const status =
      orderAmount === null
        ? 'unexpected_settlement'
        : settlementAmount === null
          ? 'missing_settlement'
          : delta === 0
            ? 'matched'
            : 'amount_mismatch';
    return { orderId, orderAmount, settlementAmount, delta, status };
  });
equal(rows, reconcile.expected.rows, 'deterministic full outer join');
equal(rows.length, reconcile.expected.rowCount, 'deterministic row count');
const sum = (values) => [...values].reduce((total, value) => total + value, 0);
equal(
  sum(orders.values()),
  reconcile.expected.ordersTotal,
  'order total in integer fen',
);
equal(
  sum(settlements.values()),
  reconcile.expected.settlementsTotal,
  'settlement total in integer fen',
);
equal(
  sum(orders.values()) - sum(settlements.values()),
  reconcile.expected.netDifference,
  'net difference',
);

equal(
  cases.A08.input.actualFileChecksum,
  sha(cases.A08.input.actualFileContent),
  'user edit checksum',
);
equal(
  cases.A08.expected.finalFileContent,
  cases.A08.input.actualFileContent,
  'restore protects user edit',
);
check(
  Date.parse(cases.A03.input.approval.expiresAt) > Date.parse(data.fixedNow),
  'A03 rejects version, not an already-expired approval',
);
let reserved = cases.A11.input.rootBudget.reserved;
const budget = cases.A11.input.rootBudget;
const decisions = cases.A11.input.reservationRequests.map((amount) => {
  if (budget.used + reserved + amount > budget.maxModelCalls)
    return 'deny_budget';
  reserved += amount;
  return 'reserved';
});
equal(
  decisions,
  cases.A11.expected.reservationDecisions,
  'sequential reservation reference',
);
equal(
  budget.used + reserved,
  cases.A11.expected.usedPlusReserved,
  'root budget reference',
);
const children = cases.A12.input.childArtifactRefs.map(
  (id) => data.artifacts[id],
);
equal(
  new Set(children.map((item) => item.runId)).size,
  2,
  'separate child provenance',
);
equal(
  new Set(children.map((item) => item.relativePath)).size,
  1,
  'deliberately colliding logical path',
);

const files = [
  'README.md',
  'docs/README.md',
  'docs/architecture/README.md',
  'docs/allrice-2.0.md',
  ...['baseline', 'contracts', 'decisions', 'acceptance'].map(
    (name) => `docs/architecture/allrice-2.0/${name}.md`,
  ),
];
for (const file of files) {
  const path = resolve(root, file);
  const markdown = readFileSync(path, 'utf8');
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '');
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const local = decodeURIComponent(target.split('#')[0]);
    check(
      existsSync(resolve(dirname(path), local)),
      `${file} links to ${local}`,
    );
    localLinks += 1;
  }
}
const contractDocument = read('contracts.md');
for (const id of contracts)
  check(
    contractDocument.includes(`## ${id}.`),
    `${id} semantic section exists`,
  );

log(
  JSON.stringify(
    {
      status: 'material_checks_passed',
      assertions,
      localLinks,
      cases: data.cases.length,
      contracts: contracts.size,
      gaLines: gaLines.size,
      runtimeTestsExecuted: false,
    },
    null,
    2,
  ),
);
