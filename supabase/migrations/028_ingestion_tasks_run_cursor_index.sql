-- Durable coverage reads page by the immutable task UUID inside one run.
-- Keep that access path indexed as task history grows across ingestion slots.
create index if not exists ingestion_tasks_run_id_id_idx
  on public.ingestion_tasks (ingestion_run_id, id);
