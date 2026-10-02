-- Discovery metadata does not change published content or frozen Run inputs.
alter table allrice_company_assets add column pinned boolean not null default false;
