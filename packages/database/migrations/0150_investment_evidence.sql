-- Human-confirmed business units and costing inputs are distinct from immutable
-- Runs, deliverables and provider receipts. Every change appends a revision.
create table allrice_investment_entries (
 id uuid primary key,
 kind text not null check(kind in ('baseline','work','expense','statement')),
 organization_id uuid references allrice_organizations(id),
 workspace_id uuid references allrice_workspaces(id),
 owner_id uuid not null references allrice_users(id),
 entry_key text not null,
 revision integer not null default 0 check(revision>=0),
 latest_revision_id uuid,
 source_version_id uuid references allrice_deliverable_versions(id),
 created_at timestamptz not null default clock_timestamp(),
 check((kind='expense')=(organization_id is null)),
 check((kind='work')=(workspace_id is not null)),
 check(source_version_id is null or kind='work')
);
create unique index allrice_investment_company_key on allrice_investment_entries(organization_id,kind,entry_key) where kind in ('baseline','statement');
create unique index allrice_investment_business_key on allrice_investment_entries(organization_id,owner_id,entry_key) where kind='work';
create unique index allrice_investment_adopted_version on allrice_investment_entries(source_version_id) where kind='work' and source_version_id is not null;
create unique index allrice_investment_expense_key on allrice_investment_entries(entry_key) where kind='expense';
create index allrice_investment_company_directory on allrice_investment_entries(organization_id,kind,id);
create table allrice_investment_revisions (
 id uuid primary key,
 entry_id uuid not null references allrice_investment_entries(id),
 number integer not null check(number>0),
 content jsonb not null,
 facts jsonb not null,
 digest text not null check(digest ~ '^sha256:[a-f0-9]{64}$'),
 created_by uuid not null references allrice_users(id),
 created_at timestamptz not null default clock_timestamp(),
 unique(entry_id,number),unique(entry_id,id)
);
alter table allrice_investment_entries add foreign key(id,latest_revision_id) references allrice_investment_revisions(entry_id,id);
create function allrice_investment_revision_immutable() returns trigger language plpgsql as $$
begin raise exception 'investment revisions are immutable'; end; $$;
create trigger allrice_investment_revision_immutable before update or delete on allrice_investment_revisions for each row execute function allrice_investment_revision_immutable();
