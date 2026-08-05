const baseUrl = process.env.ALLRICE_SMOKE_BASE_URL;
const encodedState = process.env.ALLRICE_SMOKE_STATE;
if (!baseUrl || !encodedState) {
  throw new Error(
    'ALLRICE_SMOKE_BASE_URL and ALLRICE_SMOKE_STATE are required',
  );
}

const state = JSON.parse(
  Buffer.from(encodedState, 'base64url').toString('utf8'),
);
const response = await fetch(`${baseUrl}${state.signedUrl}`);
if (!response.ok) {
  throw new Error(
    `signed download after restart failed: ${response.status} ${await response.text()}`,
  );
}
if ((await response.text()) !== state.persistedContent) {
  throw new Error('storage content changed after restart');
}

console.info('AllRice database/storage restart smoke passed');
