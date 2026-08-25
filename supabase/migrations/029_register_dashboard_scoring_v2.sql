-- Register the strict rolling-72-hour Top 100 score contract as immutable
-- provenance. Existing 1.0.0 runs retain their original model reference.
do $dashboard_model_v2$
declare
  dashboard_model_key constant text := 'technology_dashboard';
  dashboard_model_version constant text := '2.0.0';
  dashboard_model_hash constant text := 'e7e8527efdc21584ab98e8d74d12bf4cd8efae6a875e4d496afe868cb6f3c0bf';
  dashboard_model_config constant jsonb := $config$
  {
    "clusteringVersion": "dashboard-cluster-v1",
    "eligibility": {
      "publicationPrecision": "exact",
      "sourceLinkStatus": "verified",
      "sourceVerified": true,
      "socialMinimumNativeViews": 1000000,
      "windowHours": 72
    },
    "schemaVersion": "technology-dashboard-v2",
    "surfacing": {
      "newsFormula": "news-coverage-v1",
      "viralFormula": "viral-reach-v1"
    }
  }
  $config$::jsonb;
  prior_model_id uuid;
  stored_hash text;
  stored_config jsonb;
begin
  select id
  into prior_model_id
  from public.scoring_model_versions
  where model_key = dashboard_model_key and version = '1.0.0';

  if prior_model_id is null then
    raise exception 'dashboard scoring model %.1.0.0 is unavailable', dashboard_model_key
      using errcode = '23514';
  end if;

  insert into public.scoring_model_versions (
    model_key,
    version,
    config_hash,
    config_json,
    supersedes_id
  )
  values (
    dashboard_model_key,
    dashboard_model_version,
    dashboard_model_hash,
    dashboard_model_config,
    prior_model_id
  )
  on conflict (model_key, version) do nothing;

  select config_hash, config_json
  into stored_hash, stored_config
  from public.scoring_model_versions
  where model_key = dashboard_model_key and version = dashboard_model_version;

  if stored_hash is distinct from dashboard_model_hash
    or stored_config is distinct from dashboard_model_config then
    raise exception
      'dashboard scoring model %.% exists with config drift; expected hash %',
      dashboard_model_key, dashboard_model_version, dashboard_model_hash
      using errcode = '23514';
  end if;
end
$dashboard_model_v2$;
