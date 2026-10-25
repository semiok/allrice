-- MET-222: the M1 monitor (scripts/m1/monitor) records every alert it raises and every
-- recovery next to the model-governance incidents. Platform-level rows: organization_id
-- stays null; detail_code is "monitor.<check key>", metadata carries the alert id that
-- links a recovery to the alert it closes.
alter table allrice_operational_incidents
  drop constraint allrice_operational_incidents_kind_check;
alter table allrice_operational_incidents
  add constraint allrice_operational_incidents_kind_check check (kind in (
    'quota_exceeded', 'circuit_opened', 'kill_switch', 'provider_recovered',
    'monitor_alert', 'monitor_recovered'
  ));
