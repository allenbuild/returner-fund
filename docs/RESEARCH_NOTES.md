# Research Notes

## Latest Anomaly Pass

- Generated at: 2026-06-29T09:31:47.471Z.
- Anomalies: 198.
- Follow-up tasks: 333.

## Long-Run Root Cause Notes

- Shallow social evidence was mostly caused by profile/context collection without post-level promotion. Profile URLs stay identity context only; discovered public post URLs now get a separate verification step.
- Instagram remains the most blocked public source: direct profile pages still return login-wall/block content in the doctor and broad public runs. Targeted HeyClicky reel evidence remains the known working Instagram path.
- X public search/profile paths discover many candidates, but post text/metrics are often blocked. The next resumed broad run should force-refresh X/Instagram after the new post verifier so `/status/` and `/reel/` candidates can be retried.
- Long-run observation: Jina Reader can return HTTP 451 cooldowns for anonymous `x.com` access. Cooldowns should be logged once per platform window and subsequent X tasks skipped until the stated expiry.
- Attribution review update: the hard guard reports 0 high and 0 medium scored attribution failures. The first-party social body-signal queue has 972 scored rows, including 778 founder rows and 1 high-priority probable off-topic rows. Keep this as review instrumentation before changing founder/social scoring weights.

## Highest Priority Anomalies

- jo: high_raw_views_low_score - Visible views 423376 but score 33.
- Napkin Math: high_raw_views_low_score - Visible views 67939 but score 39.
- primitive: high_raw_views_low_score - Visible views 71883 but score 38.
- 9 Mothers: high_social_low_score - 13 scored social rows but score 38.
- AgentPhone: high_social_low_score - 46 scored social rows but score 43.
- Akkari: high_social_low_score - 8 scored social rows but score 19.
- Alchemize: high_social_low_score - 9 scored social rows but score 33.
- Allowance: high_social_low_score - 14 scored social rows but score 40.
- Andco: high_social_low_score - 21 scored social rows but score 30.
- Andustry: high_social_low_score - 10 scored social rows but score 32.
- Archer: high_social_low_score - 16 scored social rows but score 39.
- Arlo Industries: high_social_low_score - 11 scored social rows but score 38.
- Atrisa: high_social_low_score - 10 scored social rows but score 22.
- Autostep: high_social_low_score - 7 scored social rows but score 36.
- Auxos: high_social_low_score - 22 scored social rows but score 37.
- BentoLabs AI: high_social_low_score - 43 scored social rows but score 39.
- Callab AI: high_social_low_score - 6 scored social rows but score 34.
- CharacterQuilt: high_social_low_score - 12 scored social rows but score 13.
- Cignara: high_social_low_score - 19 scored social rows but score 19.
- Clara: high_social_low_score - 3 scored social rows but score 33.
- Clawvisor: high_social_low_score - 6 scored social rows but score 43.
- Cohesion: high_social_low_score - 24 scored social rows but score 22.
- Deep Interactions: high_social_low_score - 6 scored social rows but score 35.
- Drip: high_social_low_score - 10 scored social rows but score 36.
- Fuchsia: high_social_low_score - 5 scored social rows but score 25.
- General Aviation: high_social_low_score - 4 scored social rows but score 34.
- Gravy: high_social_low_score - 5 scored social rows but score 33.
- Harbor: high_social_low_score - 15 scored social rows but score 25.
- Hedge: high_social_low_score - 22 scored social rows but score 13.
- Imperfect: high_social_low_score - 22 scored social rows but score 13.
- InLoop Robotics: high_social_low_score - 16 scored social rows but score 44.
- InstaAgent: high_social_low_score - 31 scored social rows but score 29.
- jo: high_social_low_score - 4 scored social rows but score 33.
- Keyframe Labs: high_social_low_score - 12 scored social rows but score 42.
- Kinect: high_social_low_score - 3 scored social rows but score 21.
- Kuli: high_social_low_score - 11 scored social rows but score 37.
- Lattice Health: high_social_low_score - 7 scored social rows but score 13.
- Light Anchor: high_social_low_score - 24 scored social rows but score 34.
- Lightsprint: high_social_low_score - 16 scored social rows but score 30.
- Limrun: high_social_low_score - 3 scored social rows but score 35.

Full machine-readable output: `outputs/anomaly-report-s2026.json`.
