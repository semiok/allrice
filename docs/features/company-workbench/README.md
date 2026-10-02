# Company workbench

Status: MET165 PR1 implemented; Dev delivery evidence is recorded separately.
Owner: AllRice. Issue: [MET165](https://linear.app/metasnowsky/issue/MET-165).

The administration “公司看板” opens a company-wide work overview. A compact
company selector is followed by employee, AI employee, job and period filters.
Selecting an employee is optional. Existing `view=activity`, `organizationId`
and `subjectId` links remain valid.

## Facts and authority

The overview reads formal employee Runs, assignments, task clocks, immutable
deliverable versions, storage objects and model usage receipts. It creates no
work, advances no clocks and never impersonates an employee. Every request
checks the actual administrator’s current session and platform authority.
Platform test organizations and subordinate assistant Runs are excluded; a
formal root Run remains one work item when assistant execution is enabled.

Started work uses creation time; terminal work uses completion time. Live
running, waiting and queued work is independent of the selected historical
period. Ranges use explicit UTC instants, a half-open interval and a validated
IANA display timezone. Archived conversations and disabled employees retain
their history. Read-only Run/artifact inspection supports archived sessions;
write and execution permissions are unchanged.

Available deliveries count readable business series once, separately from
first deliveries and revisions during the period. Raw command output, browser
evidence and tool-result paging files do not count as business deliveries.
Unknown receipts and charges remain unknown. Cache is part of input tokens.
Subscriptions are not repriced as API usage; the legacy ledger has no frozen
billing currency, so it is not presented as a CNY/USD bill or combined with
assistant price upper bounds.

## API and interaction

`GET /api/v1/admin/activity?view=dashboard&organizationId=...` returns the
authoritative summary. `view=companyRuns` returns the matching work list with
optional owner, AI employee, job, period, measure and state filters. Pagination
uses creation time plus Run UUID and rejects foreign cursors. The legacy
person-only endpoint preserves its original archive filtering.

Automatic refresh runs only while live work exists, every 15 seconds in a
visible page. It keeps loaded pages, selection, scroll, expanded details and
the displayed file version. Explicit filter changes cancel stale requests.
The existing DSH dialog and tenant inspection components show work details;
preview and download still recheck exact organization/workspace/owner/Run/file
scope and storage checksums.

## Validation and remaining slices

Isolated PostgreSQL checks cover two companies, archived sessions, former
employees, empty-company/unknown usage, time boundaries, root Run counting,
known zero versus missing token receipts, foreign cursors and revoked
administrator sessions. Browser checks exercise desktop/mobile filtering,
detail retention, previews, downloads and ordinary-account denial against
the real HTTP handlers and isolated database.

PR2 adds the company deliverable library and native preview. PR3/PR4 add
explicitly published company rules/templates and immutable Run references.
ROI estimation and model-generated recommendations belong to later rounds.
