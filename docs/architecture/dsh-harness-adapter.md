# DSH Harness Adapter

AllRice integrates DeepSeek Harness (DSH) as a headless execution engine, not
as a second product UI and not as a source of tenant authorization. The pinned
upstream facts live in `apps/worker/dsh/upstream.json`; upgrades are explicit,
reviewed changes to that file, the restricted Cordis composition and the
adapter conformance suite.

## Boundary

AllRice owns the employee definition, user/tenant identity, capability
snapshot, credentials, Tool Broker policy, execution audit and durable context
checkpoint. DSH owns one long-lived model session, the agent loop, streaming
model events and provider protocol. DSH receives an allowlisted child-process
environment and never inherits the Worker environment.

The deployment secret bridge accepts an `ALLRICE_DSH_CREDENTIALS_JSON` object
or a private `ALLRICE_DSH_CREDENTIALS_FILE` containing that object. Credential
files must not be group or world accessible. Values are bindings, not bare
keys. A binding must either carry matching
`organizationId`, nullable `workspaceId` and nullable `ownerId`, or explicitly
declare `{"scope":"deployment"}`. The adapter resolves the binding for the
frozen run tenant and passes only that one API key to one child process. Key
rotation changes the runtime fingerprint and replaces the process on the next
turn; key material is never persisted in employee or run snapshots.

The first managed OpenAI-compatible preset is MiniMax. Employee definitions
store only the route (`openai-compatible`), model (`MiniMax-M3`), official
China endpoint and `deployment:minimax-default` credential reference. The API
key is deployment-owned Worker configuration and is never entered in the Web
UI or committed to the repository.

The restricted composition intentionally omits shell, terminal, filesystem,
browser, direct-network, MCP, subagent and dynamic-plugin packages. DSH cannot
invoke those facilities even if a model asks for them. Authorized AllRice tools
cross a narrow JSON envelope, are validated against the frozen tool directory,
and execute only through `HarnessExecutionInput.onToolCall`.

## Supported matrix

| Capability         | DSH 0.1.1-rc.2 behavior                                                            |
| ------------------ | ---------------------------------------------------------------------------------- |
| Multi-turn session | One JSON-RPC runtime and stable session id per AllRice conversation                |
| Streaming          | `assistant/chunk` text deltas map to `HarnessEvent`                                |
| Usage              | `assistant/message.data.usage` maps to `usage.updated`                             |
| Tools              | AllRice Tool Broker bridge only; no DSH host tools                                 |
| Interrupt          | Abort closes only that conversation runtime                                        |
| Compact            | Closes the native runtime; AllRice writes an extractive `ContextCheckpoint`        |
| Recover            | Starts a clean runtime and rehydrates from the AllRice checkpoint/bootstrap prompt |
| Active-turn steer  | Unsupported by the pinned SDK wire protocol                                        |
| Providers          | `deepseek-official` and restricted `openai-compatible` (managed MiniMax preset)    |

## Upstream limitations

The pinned SDK protocol exposes `initialize`, `session/prompt` and `shutdown`.
It has no wire method for cancel, compact, recover or protocol negotiation.
AllRice therefore implements interruption with process isolation and implements
compact/recover at the AllRice checkpoint boundary. These are deliberately
advertised separately from unsupported active-turn steering.

The DSH web interface is not built, packaged or deployed. All user experience
continues through AllRice Web.

## Upgrade procedure

1. Review upstream release notes and license, then update the exact version,
   commit, tree and deterministic archive SHA-256 in `upstream.json`.
2. Diff the SDK protocol and event vocabulary. Do not accept silent server-name
   or method changes.
3. Audit the Cordis plugin list. No host-capability plugin may be added.
4. Run contracts, adapter conformance, credential-isolation and cancellation /
   recovery tests for both provider routes.
5. Exercise one real DeepSeek and one real OpenAI-compatible deployment only
   with deployment-owned test credential bindings; never commit keys.
