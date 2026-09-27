# MET-163 platform models and image delivery

The platform configures one Codex subscription connection, a conversation model,
and an image model in **平台设置 → 模型与用量**. Employee editors inherit these
settings. A newly bound Run captures the platform revision and image configuration;
changing settings never rewrites an existing Run or historical provider receipt.

## Subscription compatibility evidence (2026-09-27)

Two real requests used the Dev Worker's managed DSH OAuth grant and configured
egress route, through `https://chatgpt.com/backend-api/codex/responses`. No personal
Codex credentials, API key, placeholder image or paid API fallback was used.

| Request              | Work model / image tool model      | Result                                            |
| -------------------- | ---------------------------------- | ------------------------------------------------- |
| Generate             | gpt-5.6-luna / gpt-image-2.5-flare | HTTP 200, completed, PNG 1254×1254, 669456 bytes  |
| Edit generated image | same                               | HTTP 200, completed, PNG 1254×1254, 1055161 bytes |

Visual inspection confirmed a blue circle on white changed to orange while
preserving composition. Original and edited files were saved separately.
Checksums: generation `52c83d06f8fe7e9b522e71e80997d1a05bd160100912a318025f6fa09a7fa5c0`,
edit `ab8ceb041d9833651b78a8a996e6e1badb8828f82821f876ca35064d1efaf936`.
The endpoint returned Responses usage but no separately established image cost;
do not infer a price or remaining subscription allowance from these receipts.
The requested size was 1024×1024, but the actual returned dimensions above differed:
use decoded dimensions as truth, not the request parameters.

Official references: [image tool](https://developers.openai.com/api/docs/guides/image-generation),
[model catalog](https://developers.openai.com/api/docs/models/all),
[authentication](https://learn.chatgpt.com/docs/auth).
Sunburst is documented but was not exercised; only the verified Flare candidate
is initially selectable. Availability must be checked again after an authorization
or upstream compatibility change.

## Migration and recovery

Apply migration 0117 before starting the new server/Worker. It creates the platform
singleton with the existing default Codex connection and disables Gemini catalog
entries/connections, including legacy Gemini OAuth rows. It preserves identifiers,
credentials references, historical snapshots and artifacts. New model configuration
and the runtime reject retired Gemini even if an old enable environment variable
remains. The old credential endpoint returns 410 after authorization.

The default image toggle stays off until the image execution/UX PRs are installed.
Do not replace an active Worker during a Gemini request: drain existing Runs first.
Rollback of a configuration is another audited save of the previous values with
the current expected revision. Keep the additive table and all new historical
snapshots; do not attempt a database downgrade. Re-enabling a retired provider is
outside a configuration rollback and needs a separate reviewed reintroduction.

Implementation is stacked on the current Dev UI integration branch to preserve
the already-reviewed organization, employee and workbench changes. Each PR diff
should be reviewed against its stated predecessor before eventual main integration.
