---
name: workspace-briefing
description: Inspect the currently authorized local workspace and produce a grounded briefing from its files and Git state. Use when a user asks what is in a workspace, how projects are organized, where something lives, what changed, or what context is relevant before starting work.
---

# Workspace Briefing

Build an evidence-based overview of the local folder explicitly authorized through Rice Bridge. Remain read-only and stay inside that folder.

## Workflow

1. Confirm that a local workspace is connected. If it is offline, stop and tell the user to connect one.
2. Call `local_fs_list` on the authorized root before making claims about its contents.
3. Identify likely projects from directory names and high-signal files such as `README`, package manifests, dependency files, and repository metadata.
4. Use `local_fs_search` to locate relevant terms and `local_fs_read` to inspect only the files needed to answer the request.
5. When repository state matters, use `local_git_status`; use `local_git_diff` only when the user asks about changes or the changes are necessary to explain the current state.
6. Summarize the workspace structure, likely purpose, current state, and useful next actions. Cite relative file paths as evidence.

## Reading Strategy

- Start broad with the root, then narrow into relevant projects.
- Prefer metadata and small text files before reading large files.
- Avoid generated output, dependencies, caches, binaries, secrets, and unrelated personal content.
- Do not infer that an inaccessible or unread file contains particular information.
- If names are ambiguous, label the interpretation as a hypothesis and identify the evidence used.

## Boundaries

- Never use Shell or write, rename, delete, execute, install, or commit anything.
- Never access paths outside the selected workspace or bypass Rice Bridge restrictions.
- Do not expose secrets or copy large private documents into the response.
- If the request requires mutation or execution, finish the read-only briefing and explain that a separately approved capability is required.
