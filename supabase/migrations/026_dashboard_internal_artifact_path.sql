-- The complete Dashboard snapshot is intentionally a server-only artifact.
-- Keep the existing public-feed provenance valid while allowing the internal
-- full projection under the repository's established artifacts/ convention.

alter table public.dashboard_publications
  drop constraint if exists dashboard_publications_artifact_path_check;

alter table public.dashboard_publications
  add constraint dashboard_publications_artifact_path_check check (
    artifact_path ~ '^(public|artifacts)/dashboard/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}[.]json$'
    and artifact_path !~ '(^|/)[.][.]?(/|$)'
  );

comment on constraint dashboard_publications_artifact_path_check on public.dashboard_publications is
  'Restricts Dashboard publication provenance to reviewed public-feed or server-only artifact paths without traversal segments.';
