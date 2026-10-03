-- Reuse formal file delivery/versioning for native raster transformations.
alter table allrice_deliverable_versions drop constraint allrice_deliverable_versions_format_check;
alter table allrice_deliverable_versions add constraint allrice_deliverable_versions_format_check
  check (format in ('markdown','text','html','json','docx','xlsx','pptx','pdf','png','jpeg','webp'));
