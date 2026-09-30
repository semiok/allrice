# Native model disconnect recovery

Run `917f3a15` read GitHub check results successfully, then lost the Codex model connection with `WebSocket closed 1006`. The pinned DSH pi-ai adapter classified that message as `PI_AI_ERROR`, bypassing native request recovery. Worker subsequently retried the entire prompt under a new lease, which the assistant recovery guard correctly refused. That secondary error hid the original failure.

The narrow dependency patch classifies abnormal close code 1006 as `TRANSPORT`. DSH's existing provider policy retries the current model request at most twice using its saved conversation and tool results. Assistant admission and settlement rules still determine whether continuation is permitted; partial output, missing settlement receipts and unknown effects do not become replay authorization. Authentication, invalid requests and other unknown WebSocket close codes retain their existing classification.

After DSH emits a terminal turn failure, Worker preserves its code and ends that queue attempt without replaying the prompt. A changed assistant lease or generation now returns the typed, nonretryable `DSH_RECOVERY_REQUIRED` error. Existing usage and operation evidence remain intact.

The transcript explains model disconnection, model timeout or unsafe recovery. A complete reply already delivered before failure remains visible with the failure explanation. If there is no complete reply, the saved message contains the explanation and points to the existing work-process records; no result is invented from tool content.

Validation uses real pinned pi-ai/DSH against synthetic loopback responses, native retries after an MCP result, terminal adapter failures, isolated PostgreSQL receipts and transcript rendering. It verifies two native retries, one completed tool invocation, original terminal codes, preserved complete output and no queue retry. Public Dev verification inspects the original run read-only and tests the new presentation through browser-local response fixtures, without executing its historical GitHub task.
