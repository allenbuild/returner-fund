-- The dashboard's core catalog and graph relations intentionally remain publicly readable.
-- Anonymous and authenticated clients keep SELECT-only access to these seven tables;
-- all writes continue through trusted server code using service_role.
alter table public.batches enable row level security;
alter table public.companies enable row level security;
alter table public.founders enable row level security;
alter table public.company_founders enable row level security;
alter table public.industries enable row level security;
alter table public.company_industries enable row level security;
alter table public.graph_edges enable row level security;

revoke all privileges on table public.batches from anon, authenticated;
revoke all privileges on table public.companies from anon, authenticated;
revoke all privileges on table public.founders from anon, authenticated;
revoke all privileges on table public.company_founders from anon, authenticated;
revoke all privileges on table public.industries from anon, authenticated;
revoke all privileges on table public.company_industries from anon, authenticated;
revoke all privileges on table public.graph_edges from anon, authenticated;

grant select on table public.batches to anon, authenticated;
grant select on table public.companies to anon, authenticated;
grant select on table public.founders to anon, authenticated;
grant select on table public.company_founders to anon, authenticated;
grant select on table public.industries to anon, authenticated;
grant select on table public.company_industries to anon, authenticated;
grant select on table public.graph_edges to anon, authenticated;

grant all privileges on table public.batches to service_role;
grant all privileges on table public.companies to service_role;
grant all privileges on table public.founders to service_role;
grant all privileges on table public.company_founders to service_role;
grant all privileges on table public.industries to service_role;
grant all privileges on table public.company_industries to service_role;
grant all privileges on table public.graph_edges to service_role;

-- Recreate the expected policy definitions on replay. A name-only existence
-- guard would preserve a stale or overly broad public_read policy forever.
drop policy if exists public_read on public.batches;
create policy public_read on public.batches for select to anon, authenticated using (true);
drop policy if exists public_read on public.companies;
create policy public_read on public.companies for select to anon, authenticated using (true);
drop policy if exists public_read on public.founders;
create policy public_read on public.founders for select to anon, authenticated using (true);
drop policy if exists public_read on public.company_founders;
create policy public_read on public.company_founders for select to anon, authenticated using (true);
drop policy if exists public_read on public.industries;
create policy public_read on public.industries for select to anon, authenticated using (true);
drop policy if exists public_read on public.company_industries;
create policy public_read on public.company_industries for select to anon, authenticated using (true);
drop policy if exists public_read on public.graph_edges;
create policy public_read on public.graph_edges for select to anon, authenticated using (true);

-- Raw social/evidence rows, observations, operational queues, discovery output,
-- scoring state, run logs, and snapshots are internal. RLS has no client policy
-- for these tables, and API-role privileges are reserved for service_role.
alter table public.social_accounts enable row level security;
alter table public.posts enable row level security;
alter table public.post_metrics enable row level security;
alter table public.platform_baselines enable row level security;
alter table public.ingestion_runs enable row level security;
alter table public.scoring_runs enable row level security;
alter table public.post_scores enable row level security;
alter table public.traction_snapshots enable row level security;
alter table public.founder_traction_snapshots enable row level security;
alter table public.ingestion_tasks enable row level security;
alter table public.source_failures enable row level security;
alter table public.platform_coverage enable row level security;
alter table public.discovery_attempts enable row level security;
alter table public.source_discovery_paths enable row level security;
alter table public.evidence_items enable row level security;
alter table public.evidence_attributions enable row level security;
alter table public.metric_observations enable row level security;
alter table public.scoring_model_versions enable row level security;

revoke all privileges on table public.social_accounts from anon, authenticated;
revoke all privileges on table public.posts from anon, authenticated;
revoke all privileges on table public.post_metrics from anon, authenticated;
revoke all privileges on table public.platform_baselines from anon, authenticated;
revoke all privileges on table public.ingestion_runs from anon, authenticated;
revoke all privileges on table public.scoring_runs from anon, authenticated;
revoke all privileges on table public.post_scores from anon, authenticated;
revoke all privileges on table public.traction_snapshots from anon, authenticated;
revoke all privileges on table public.founder_traction_snapshots from anon, authenticated;
revoke all privileges on table public.ingestion_tasks from anon, authenticated;
revoke all privileges on table public.source_failures from anon, authenticated;
revoke all privileges on table public.platform_coverage from anon, authenticated;
revoke all privileges on table public.discovery_attempts from anon, authenticated;
revoke all privileges on table public.source_discovery_paths from anon, authenticated;
revoke all privileges on table public.evidence_items from anon, authenticated;
revoke all privileges on table public.evidence_attributions from anon, authenticated;
revoke all privileges on table public.metric_observations from anon, authenticated;
revoke all privileges on table public.scoring_model_versions from anon, authenticated;

grant all privileges on table public.social_accounts to service_role;
grant all privileges on table public.posts to service_role;
grant all privileges on table public.post_metrics to service_role;
grant all privileges on table public.platform_baselines to service_role;
grant all privileges on table public.ingestion_runs to service_role;
grant all privileges on table public.scoring_runs to service_role;
grant all privileges on table public.post_scores to service_role;
grant all privileges on table public.traction_snapshots to service_role;
grant all privileges on table public.founder_traction_snapshots to service_role;
grant all privileges on table public.ingestion_tasks to service_role;
grant all privileges on table public.source_failures to service_role;
grant all privileges on table public.platform_coverage to service_role;
grant all privileges on table public.discovery_attempts to service_role;
grant all privileges on table public.source_discovery_paths to service_role;
grant all privileges on table public.evidence_items to service_role;
grant all privileges on table public.evidence_attributions to service_role;
grant all privileges on table public.metric_observations to service_role;
grant all privileges on table public.scoring_model_versions to service_role;
