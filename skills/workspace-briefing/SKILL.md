---
name: workspace-briefing
description: 检查当前获准访问的 AllRice 云端文件或 Rice Bridge 本地工作区，根据文件内容和 Git 状态生成有依据的工作简报。
---

# Workspace Briefing

Build an evidence-based overview from the currently authorized AllRice cloud files or the local folder explicitly authorized through Rice Bridge. Remain read-only and stay inside the active workspace.

## Workflow

1. Determine whether the user refers to AllRice cloud files, a Rice Bridge local workspace, or both.
2. For cloud files, call `workspace_file_list`, then use `workspace_document_read` only for relevant files. For local files, confirm that Rice Bridge is connected and call `local_fs_list` on the authorized root.
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
- Never access paths outside the selected workspace or bypass AllRice authorization or Rice Bridge restrictions.
- Do not expose secrets or copy large private documents into the response.
- If the request requires mutation or execution, finish the read-only briefing and explain that a separately approved capability is required.
