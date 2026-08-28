-- Keep the foundational workspace briefing useful without recursively
-- inventorying every project. The same reviewed body is propagated to the
-- platform source and already-materialized tenant copies.

update allrice_platform_dsh_skills
set content = $skill$# Workspace Briefing

Build an evidence-based overview of the local folder explicitly authorized through Rice Bridge. Remain read-only and stay inside that folder.

## Workflow

1. Confirm that a local workspace is connected. If it is offline, stop and tell the user to connect one.
2. Call `local_fs_list` on the authorized root before making claims about its contents.
3. Identify likely projects from directory names. Do not open every project merely to enrich a general overview.
4. When repository state matters, call `local_git_status` only for the most relevant likely repositories.
5. Use `local_fs_search` or `local_fs_read` only when the user's question cannot be answered from the directory listing and Git status.
6. Use `local_git_diff` only when the user explicitly asks about changes or a diff is necessary to explain a dirty repository.
7. Summarize the workspace structure, likely purpose, current state, and useful next actions. Cite relative file paths as evidence.

## Default Call Budget

For a general workspace briefing, optimize for a useful answer in a few calls:

- List the authorized root once.
- Inspect Git status for at most three likely repositories.
- Read at most two small, high-signal files in total, and only when needed.
- Search at most once, and only for a user-specified topic or an ambiguous project.
- Do not fetch diffs unless the user asks about changes.
- Stop once the requested overview is supported. Do not recursively inventory the workspace.

If the user explicitly asks for a deep audit, explain that it will take longer and expand the budget only for that request.

## Reading Strategy

- Start broad with the root, then narrow into relevant projects.
- Prefer metadata and small text files before reading large files.
- Treat directory names as tentative evidence; use concise labels such as “likely” when purpose has not been verified from a file.
- Avoid generated output, dependencies, caches, binaries, secrets, and unrelated personal content.
- Do not infer that an inaccessible or unread file contains particular information.
- If names are ambiguous, label the interpretation as a hypothesis and identify the evidence used.

## Boundaries

- Never use Shell or write, rename, delete, execute, install, or commit anything.
- Never access paths outside the selected workspace or bypass Rice Bridge restrictions.
- Do not expose secrets or copy large private documents into the response.
- If the request requires mutation or execution, finish the read-only briefing and explain that a separately approved capability is required.
$skill$,
    checksum = 'sha256:6297b8a52dc0286a9cf9c747b4406d282eba1dae06b562f8a11657d6bad9d0ee',
    updated_at = now()
where name = 'workspace-briefing';

update allrice_dsh_skills
set content = platform.content,
    description = platform.description,
    checksum = platform.checksum,
    model_invocable = platform.model_invocable,
    user_invocable = platform.user_invocable,
    required_tool_refs = platform.required_tool_refs,
    enabled = platform.enabled,
    updated_at = now()
from allrice_platform_dsh_skills platform
where allrice_dsh_skills.name = 'workspace-briefing'
  and platform.name = allrice_dsh_skills.name;

insert into allrice_runtime_metadata (key, value)
values (
  'workspace-briefing-budget',
  '{"version":"0053","issue":"MET-92","defaultMode":"bounded","deepAudit":"explicit-only"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
