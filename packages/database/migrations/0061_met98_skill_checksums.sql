update allrice_platform_dsh_skills
set checksum = 'sha256:c27373c39847bc1f17a4588c18d30aaa6ed7336183a4aa6abb8ef37df4150d5f',
    updated_at = now()
where name = 'governed-memory'
  and version = '1.0.0';

update allrice_platform_dsh_skills
set checksum = 'sha256:df2ff566ee59d9f711289eb9ca190636244cb8885388e8ab5ffad21f67edc659',
    updated_at = now()
where name = 'workflow-automation'
  and version = '1.0.0';
