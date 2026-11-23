// Match the released native frontend's browser externalization. The native
// Loader owns its no-Node-internals path; this never supplies a Node loader.
export function createRequire(): never {
  throw new Error(
    'Node module loading is unavailable in this browser document',
  );
}
