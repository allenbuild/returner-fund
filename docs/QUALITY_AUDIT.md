# Quality Audit

## Latest Run

- Generated at: 2026-06-29T09:32:12.479Z.
- Status: pass_with_findings.
- Findings: 0 critical, 0 high, 0 medium, 5 low, 0 info.
- Company nodes: 197; founder nodes: 0.
- Evidence rows: 3013; scored evidence rows: 1754.
- Graph API: 138ms, 11624047 bytes.
- Graph API samples: 909ms, 138ms.
- Attribution loop: finished, elapsed 300 minutes.

## Findings

- [low] attribution.first_party_social_review_queue: 1 high-priority first-party social posts need off-topic review before founder/social weighting is increased. Examples: primitive: x Article it was always email (if you know where the headline image is from, can we be frie... (https://x.com/itsjustemail/status/2068957929772843506).
- [low] coverage.x_strict_attribution_gap: X has evidence for 133 companies, with 128 still scoring after stricter attribution guards.
- [low] coverage.instagram_sparse: Instagram remains sparse; only verified HeyClicky evidence is currently scored.
- [low] coverage.product_hunt_empty: Product Hunt has no scored evidence; needs reviewed verified launch URLs.
- [low] instagram.doctor_needs_attention: Instagram doctor still needs explicit reusable session config for browser probe.

## Notes

- Critical findings should block score publication.
- `--strict` exits non-zero for critical, high, or medium findings.
- High findings should be resolved before expanding ingestion.
- Low coverage findings are tracked but expected while platform discovery is intentionally conservative.

Machine-readable output: `outputs/quality-audit-latest.json`.
