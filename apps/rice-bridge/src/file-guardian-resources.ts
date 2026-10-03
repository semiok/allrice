/** Replaced by the release builder with an embedded, architecture-specific hash. */
export function inspectFixedFileGuardian(): string {
  throw Error('FILE_GUARDIAN_REQUIRES_FIXED_PACKAGE');
}

export function fileGuardianReady(): boolean {
  try {
    inspectFixedFileGuardian();
    return true;
  } catch {
    return false;
  }
}
