-- Register the global-best headline benchmark as a new immutable model version.
-- Earlier scoring model rows remain untouched as rollback targets.
-- This hash is SHA-256 over the recursively key-sorted, whitespace-free JSON
-- representation of TRACTION_SCORING_CONFIG.
do $migration$
declare
  v4_model_key constant text := 'returner-traction';
  v4_version constant text := '4.2.0';
  v4_config_hash constant text := '189253e22f888dfb893c5a6bfce2f5ddaa36aa4199d8729f15a9af1fa0db436c';
  v4_config constant jsonb := $config$
{
  "modelId": "returner-traction",
  "version": "4.2.0",
  "name": "returner-traction-v4-absolute-fixed-platform-global-best",
  "platformWeights": {
    "x": 0.21,
    "instagram": 0.21,
    "linkedin": 0.15,
    "github": 0.15,
    "youtube": 0.1,
    "product_hunt": 0.07,
    "hacker_news": 0.05,
    "reddit": 0.04,
    "bilibili": 0.02
  },
  "metricWeights": {
    "github": { "stars": 1.5, "forks": 4, "issues": 0.5 },
    "x": { "views": 0.04, "likes": 1.4, "replies": 4.5, "reposts": 6, "quotes": 6 },
    "linkedin": { "views": 0.04, "reactions": 1.4, "comments": 4.5, "reposts": 6 },
    "instagram": { "views": 0.04, "likes": 1.1, "comments": 4.5, "shares": 5, "saves": 4 },
    "product_hunt": { "upvotes": 2, "comments": 3.5 },
    "youtube": { "views": 0.025, "likes": 1, "comments": 3.5 },
    "hacker_news": { "upvotes": 2, "comments": 3.5 },
    "reddit": { "upvotes": 2, "comments": 3.5 },
    "bilibili": { "views": 0.025, "likes": 1, "comments": 3.5, "shares": 4 },
    "web": {},
    "rss": {}
  },
  "platformReferences": {
    "github": { "highEngagement": 40000 },
    "x": { "highEngagement": 120000 },
    "linkedin": { "highEngagement": 18000 },
    "instagram": { "highEngagement": 80000 },
    "product_hunt": { "highEngagement": 4000 },
    "youtube": { "highEngagement": 35000 },
    "hacker_news": { "highEngagement": 2500 },
    "reddit": { "highEngagement": 4000 },
    "bilibili": { "highEngagement": 35000 }
  },
  "absoluteEvidenceWeight": 1,
  "cohortPercentileWeight": 0,
  "strongestPlatformWeight": 0,
  "diversifiedPlatformWeight": 1,
  "platformEvidenceSlots": [0.82, 0.08, 0.05, 0.03, 0.02],
  "batchCalibration": {
    "absoluteScoreWeight": 1,
    "cohortPercentileWeight": 0
  },
  "confidence": {
    "base": 0.2,
    "evidenceDepthWeight": 0.38,
    "evidenceDepthScale": 4,
    "platformBreadthWeight": 0.22,
    "publicationDateWeight": 0.12,
    "verifiedLinkWeight": 0.08,
    "mediumThreshold": 0.5,
    "highThreshold": 0.75
  }
}
$config$::jsonb;
  stored_hash text;
  stored_config jsonb;
begin
  insert into public.scoring_model_versions (
    model_key,
    version,
    config_hash,
    config_json
  ) values (
    v4_model_key,
    v4_version,
    v4_config_hash,
    v4_config
  )
  on conflict (model_key, version) do nothing;

  select scoring_model_versions.config_hash, scoring_model_versions.config_json
  into stored_hash, stored_config
  from public.scoring_model_versions
  where scoring_model_versions.model_key = v4_model_key
    and scoring_model_versions.version = v4_version;

  if stored_hash is distinct from v4_config_hash
    or stored_config is distinct from v4_config then
    raise exception
      'scoring model %.% exists with config drift; expected hash %',
      v4_model_key,
      v4_version,
      v4_config_hash
      using errcode = '23514';
  end if;
end
$migration$;
