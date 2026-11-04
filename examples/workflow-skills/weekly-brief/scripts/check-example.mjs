// Inert package resource. The packer never imports or executes this file.
// A developer may inspect this pure function locally; there is no platform runner.
export function checkExample(input) {
  return input?.synthetic === true && Array.isArray(input.facts);
}
