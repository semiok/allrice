/* global exports */
// Native Node loader: keep old release imports outside the Vitest VM/aliases.
exports.nativeImport = (url) => import(url);
