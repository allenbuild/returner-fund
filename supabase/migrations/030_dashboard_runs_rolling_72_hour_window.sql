-- The Top 100 contract moved from a rolling 24-hour window to an exact
-- rolling 72-hour window in technology_dashboard 2.0.0. Keep historical
-- 1.0.0 run rows readable without rewriting their immutable provenance, while
-- enforcing the new window on every row written after this migration.

alter table public.dashboard_runs
  drop constraint if exists dashboard_runs_window_check;

alter table public.dashboard_runs
  add constraint dashboard_runs_window_check check (
    window_end = window_start + interval '72 hours'
    and as_of_at = window_end
    and date_trunc('hour', window_end) = window_end
  ) not valid;

comment on table public.dashboard_runs is
  'Idempotent hourly Dashboard builds. Legacy 1.0.0 rows retain rolling-24-hour provenance; new runs use the exact rolling-72-hour Top 100 contract.';

comment on constraint dashboard_runs_window_check on public.dashboard_runs is
  'Enforces an exact, UTC-hour-aligned rolling 72-hour window for rows written after migration 030; kept NOT VALID so immutable legacy 24-hour rows remain readable.';
