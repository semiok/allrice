// Declared on each managed tool and enforced by DSH's native timeout-policy.
// Approval may wait one hour; the backend starts its independent execution
// budget only after admission. This is not permission for a 63-minute script.
export const managedToolWaitTimeoutMs = 3_800_000;
