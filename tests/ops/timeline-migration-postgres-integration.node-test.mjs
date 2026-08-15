import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import {
  TIMELINE_DATA_PREFLIGHT_SQL,
  TIMELINE_MIGRATION_HISTORY_MASK_SQL,
  TIMELINE_MIGRATION_PREFLIGHT_SQL,
  TIMELINE_MIGRATION_VERIFICATION_SQL,
} from "../../scripts/ops/apply-timeline-migrations.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS_DIRECTORY = path.join(REPOSITORY_ROOT, "supabase", "migrations");

const IDS = Object.freeze({
  batch: "10000000-0000-4000-8000-000000000001",
  companyA: "20000000-0000-4000-8000-000000000001",
  companyB: "20000000-0000-4000-8000-000000000002",
  event: "30000000-0000-4000-8000-000000000001",
  source: "40000000-0000-4000-8000-000000000001",
  post: "50000000-0000-4000-8000-000000000001",
});

test("PostgreSQL executes migrations 001-026 (including Dashboard storage) and enforces Timeline 020 behavior", { timeout: 30_000 }, async () => {
  // PGlite is PostgreSQL compiled to WASM. It is in-process, deterministic,
  // network-free, and closed in finally so this release gate stays bounded.
  const db = new PGlite({
    extensions: { pgcrypto },
    initialMemory: 128 * 1024 * 1024,
  });
  try {
    await bootstrapSupabaseSurfaces(db);
    const migrationNames = (await readdir(MIGRATIONS_DIRECTORY))
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right));
    assert.deepEqual(
      migrationNames.map((name) => name.slice(0, 3)),
      Array.from({ length: 26 }, (_, index) => String(index + 1).padStart(3, "0")),
    );

    for (const migrationName of migrationNames) {
      await db.exec(await readFile(path.join(MIGRATIONS_DIRECTORY, migrationName), "utf8"));
      await db.query(
        "insert into supabase_migrations.schema_migrations (version) values ($1)",
        [migrationName.slice(0, 3)],
      );
    }

    assert.equal(await scalar(db, TIMELINE_MIGRATION_PREFLIGHT_SQL), "applied");
    assert.equal(await scalar(db, TIMELINE_MIGRATION_HISTORY_MASK_SQL), "1111");
    assert.equal(
      await scalar(db, TIMELINE_DATA_PREFLIGHT_SQL),
      "primary=0;evidence=0;posts=0",
    );
    assert.equal(await scalar(db, TIMELINE_MIGRATION_VERIFICATION_SQL), "verified");

    await exerciseTimelineAttributionInvariants(db);
    assert.equal(
      await scalar(db, TIMELINE_DATA_PREFLIGHT_SQL),
      "primary=0;evidence=0;posts=0",
    );
  } finally {
    await db.close();
  }
});

async function bootstrapSupabaseSurfaces(db) {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations (version text primary key);
  `);
}

async function exerciseTimelineAttributionInvariants(db) {
  await db.exec(`
    insert into public.batches (id, slug, label)
    values ('${IDS.batch}', 'timeline-020-integration', 'Timeline 020 Integration');
    insert into public.companies (id, batch_id, name)
    values
      ('${IDS.companyA}', '${IDS.batch}', 'Timeline Company A'),
      ('${IDS.companyB}', '${IDS.batch}', 'Timeline Company B');
    insert into public.timeline_events (
      id, primary_company_id, category, title, summary, event_date,
      event_date_type, importance_score, event_key
    ) values (
      '${IDS.event}', '${IDS.companyA}', 'product_launch',
      'Released integration fixture',
      'A deterministic integration fixture validates Timeline invariants.',
      date '2026-08-02', 'announcement_date', 70, 'timeline-020-fixture'
    );
    insert into public.source_documents (
      id, original_url, canonical_url, source_type, domain, title, content_hash,
      discovery_method, source_quality_tier, attribution_status
    ) values (
      '${IDS.source}', 'https://timeline-release.invalid/source',
      'https://timeline-release.invalid/source', 'company_site',
      'timeline-release.invalid', 'Timeline release fixture', repeat('0', 64),
      'release_test', 1, 'verified'
    );
    insert into public.evidence_items (
      id, platform, evidence_kind, canonical_key, canonical_url
    ) values (
      '${IDS.post}', 'x', 'post', 'timeline-020-post',
      'https://timeline-release.invalid/post'
    );
  `);

  assert.equal(
    Number(await scalar(db, `
      select count(*) from public.timeline_event_entities
      where event_id = '${IDS.event}' and is_primary
        and company_id = '${IDS.companyA}' and relationship_type = 'subject'
    `)),
    1,
  );
  await assert.rejects(
    db.exec(`
      insert into public.timeline_event_entities (
        event_id, entity_type, company_id, relationship_type, is_primary
      ) values ('${IDS.event}', 'company', '${IDS.companyA}', 'subject', true)
    `),
    /duplicate key value|exactly one primary/i,
  );
  await assert.rejects(
    db.exec(`
      insert into public.timeline_event_evidence (
        event_id, source_document_id, evidence_role, evidence_excerpt
      ) values (
        '${IDS.event}', '${IDS.source}', 'supporting', 'Unattributed source fixture.'
      )
    `),
    /must be attributed as a subject/i,
  );

  await db.exec(`
    insert into public.source_document_entities (
      source_document_id, company_id, relationship_type, relevance_reason
    ) values (
      '${IDS.source}', '${IDS.companyA}', 'subject', 'Integration fixture subject.'
    );
    insert into public.timeline_event_evidence (
      event_id, source_document_id, evidence_role, supports_event_date,
      supports_title, supports_summary, evidence_excerpt, extracted_claims,
      source_event_date
    ) values (
      '${IDS.event}', '${IDS.source}', 'primary', true, true, true,
      'Exact fixture claim.',
      jsonb_build_object(
        'title', 'Released integration fixture',
        'summary', 'A deterministic integration fixture validates Timeline invariants.'
      ),
      date '2026-08-02'
    );
  `);

  await assert.rejects(
    db.exec(`
      insert into public.timeline_event_posts (
        event_id, evidence_id, evidence_role, relevance_reason
      ) values ('${IDS.event}', '${IDS.post}', 'supporting', 'Unattributed post fixture.')
    `),
    /requires a verified attribution/i,
  );
  await db.exec(`
    insert into public.evidence_attributions (
      evidence_id, entity_type, company_id, attribution_type, is_primary,
      review_state, risk_level, match_reason
    ) values (
      '${IDS.post}', 'company', '${IDS.companyA}', 'subject', true,
      'verified', 'low', 'Integration fixture attribution.'
    );
    insert into public.timeline_event_posts (
      event_id, evidence_id, evidence_role, relevance_reason
    ) values ('${IDS.event}', '${IDS.post}', 'supporting', 'Attributed post fixture.');
    update public.timeline_events set status = 'published' where id = '${IDS.event}';
  `);
  assert.equal(
    await scalar(db, `select status from public.timeline_events where id = '${IDS.event}'`),
    "published",
  );
  await assert.rejects(
    db.exec(`
      delete from public.source_document_entities
      where source_document_id = '${IDS.source}' and company_id = '${IDS.companyA}'
    `),
    /must be attributed as a subject|must retain verified same-company/i,
  );

  await db.exec(`
    insert into public.source_document_entities (
      source_document_id, company_id, relationship_type, relevance_reason
    ) values (
      '${IDS.source}', '${IDS.companyB}', 'subject', 'Destination fixture subject.'
    );
    insert into public.evidence_attributions (
      evidence_id, entity_type, company_id, attribution_type, is_primary,
      review_state, risk_level, match_reason
    ) values (
      '${IDS.post}', 'company', '${IDS.companyB}', 'subject', false,
      'verified', 'low', 'Destination fixture attribution.'
    );
    select public.reassign_timeline_event_primary_company('${IDS.event}', '${IDS.companyB}');
  `);
  assert.deepEqual(
    (await db.query(`
      select event.primary_company_id, entity.company_id as entity_company_id, event.status
      from public.timeline_events as event
      join public.timeline_event_entities as entity on entity.event_id = event.id
      where event.id = '${IDS.event}' and entity.is_primary
    `)).rows,
    [{ primary_company_id: IDS.companyB, entity_company_id: IDS.companyB, status: "published" }],
  );
  await assert.rejects(
    db.exec(`
      delete from public.evidence_attributions
      where evidence_id = '${IDS.post}' and company_id = '${IDS.companyB}'
    `),
    /requires a verified attribution/i,
  );
}

async function scalar(db, sql) {
  const result = await db.query(sql);
  const row = result.rows[0];
  assert.ok(row, "Expected a scalar query row.");
  return Object.values(row)[0];
}
