export class RuntimeCommandError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
