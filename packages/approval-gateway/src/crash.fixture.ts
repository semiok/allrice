// Child used only by postgres.integration.test.ts: real process loss after receiver commit.
import postgres from 'postgres';
import { createPostgresApprovalStore } from './postgres-store.js';
import { createApprovalGateway } from './gateway.js';
import { fixture } from './testing.fixture.js';
const sql = postgres(process.env.APPROVAL_TEST_DATABASE_URL!, { max: 1 });
try {
  const store = createPostgresApprovalStore(sql);
  const record = await store.get(process.env.APPROVAL_TEST_REQUEST_ID!);
  if (!record) throw Error('fixture missing');
  const f = fixture(store);
  f.options.destinations.inbox.dispatch = async (_binding, ref, payload) => {
    const response = await fetch(
      process.env.APPROVAL_TEST_RECEIVER! + '/accept',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref, payload }),
      },
    );
    return response.json();
  };
  await createApprovalGateway(f.options).execute(
    record.binding,
    record.ref,
    new AbortController().signal,
  );
} finally {
  await sql.end();
}
