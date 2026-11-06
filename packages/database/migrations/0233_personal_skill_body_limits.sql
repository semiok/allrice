-- The original SKILL.md includes frontmatter; the native body has its own
-- UTF-8 budget. Keep existing rows and all installation/authority contracts.
alter table allrice_personal_skill_versions
  drop constraint allrice_personal_skill_versions_original_text_check,
  add constraint allrice_personal_skill_versions_original_text_check
    check (octet_length(original_text) <= 8000000),
  add constraint allrice_personal_skill_versions_content_bytes_check
    check (octet_length(definition->>'content') <= 262144);
