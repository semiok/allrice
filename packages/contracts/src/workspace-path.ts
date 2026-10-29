/** Conservative across case-insensitive/NFD filesystems. This is a logical
 * ownership key, NOT physical path resolution or a symlink/sandbox boundary. */
export function workspacePathKey(path: string) {
  return path.normalize('NFC').toLowerCase();
}
export function workspacePathsOverlap(a: string, b: string) {
  const left = workspacePathKey(a),
    right = workspacePathKey(b);
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}
