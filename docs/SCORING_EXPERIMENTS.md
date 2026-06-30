# Scoring Experiments

## Latest Run

- Generated at: 2026-06-29T09:31:45.734Z.
- Baseline evidence rows: 1754.
- Recommended config: F-browser-social-v2.
- Recommendation reason: Selected by maximizing cross-platform social signal, penalizing sparse/high-view anomalies, and preserving HeyClicky/InsForge sanity-check visibility without reverting to a GitHub leaderboard.
- Formula notes: Raw engagement is computed from platform metric weights. Raw engagement is multiplied by platform-specific recency decay before log normalization. Scores are log-normalized within platform, combined by available platform weights, then adjusted for coverage. Experiment totals use an evidence-depth confidence factor, then blend absolute score with peer spread instead of forcing the batch maximum to 100.

## Recommended Platform Weights

- x: 34%
- instagram: 22%
- github: 14%
- linkedin: 14%
- product_hunt: 7%
- youtube: 5%
- hacker_news: 4%

## Recommended Metric Weights

- instagram: variant B, weights {"views":0.05,"likes":1.1,"comments":5,"shares":5,"reposts":5,"saves":5}.
- x: variant B, weights {"views":0.06,"likes":1.5,"replies":5.5,"comments":5.5,"reposts":8,"shares":8,"quotes":8}.
- linkedin: variant B, weights {"views":0.06,"likes":1.5,"reactions":1.5,"comments":5.5,"reposts":8,"shares":8}.
- github: variant A, weights {"stars":1.5,"forks":4,"watchers":2,"issues":0.5,"open_issues":0.5,"recent_commits_30d":1}.
- product_hunt: variant A, weights {"upvotes":2,"comments":3}.
- youtube: variant A, weights {"views":0.02,"likes":1,"comments":3}.
- hacker_news: variant A, weights {"upvotes":2,"comments":3}.

## Config Summary

- A-balanced-social: HeyClicky 80, InsForge 72, sparse warnings 2, high-views/low-score 25, high-GitHub/low-social 2, viral-social/low-GitHub 12.
- B-social-heavy: HeyClicky 80, InsForge 68, sparse warnings 2, high-views/low-score 24, high-GitHub/low-social 2, viral-social/low-GitHub 12.
- C-developer-heavy: HeyClicky 80, InsForge 77, sparse warnings 2, high-views/low-score 25, high-GitHub/low-social 2, viral-social/low-GitHub 12.
- D-launch-attention: HeyClicky 80, InsForge 69, sparse warnings 2, high-views/low-score 24, high-GitHub/low-social 2, viral-social/low-GitHub 12.
- F-browser-social-v2: HeyClicky 80, InsForge 70, sparse warnings 2, high-views/low-score 23, high-GitHub/low-social 2, viral-social/low-GitHub 12.
- E-learned-tuned: HeyClicky 83, InsForge 66, sparse warnings 2, high-views/low-score 25, high-GitHub/low-social 2, viral-social/low-GitHub 12.

## Diagnostics

- A-balanced-social dominated-by-one-platform examples: Ploy, smol machines, Drafted, Result, Hyper.
- A-balanced-social high-views/low-score examples: Expanse (3849790 views, score 48), Kimpton AI (817687 views, score 41), Chronicle Labs (630232 views, score 45), jo (423376 views, score 33), Revnu (408117 views, score 45).
- A-balanced-social high-GitHub/low-social examples: smol machines (3976 stars, score 67), Voquill (975 stars, score 43).
- A-balanced-social viral-social/low-GitHub examples: HeyClicky (score 80), Ploy (score 67), Drafted (score 64), Result (score 63), Hyper (score 59).
- A-balanced-social likely formula issues: TesterArmy: large visible view count but low total score, jo: large visible view count but low total score.
- B-social-heavy dominated-by-one-platform examples: Ploy, smol machines, Drafted, Result, Hyper.
- B-social-heavy high-views/low-score examples: Kimpton AI (817687 views, score 42), Chronicle Labs (630232 views, score 46), jo (423376 views, score 33), Revnu (408117 views, score 46), TesterArmy (310352 views, score 43).
- B-social-heavy high-GitHub/low-social examples: smol machines (3976 stars, score 67), Voquill (975 stars, score 37).
- B-social-heavy viral-social/low-GitHub examples: HeyClicky (score 80), Ploy (score 67), Drafted (score 64), Result (score 63), Hyper (score 59).
- B-social-heavy likely formula issues: jo: large visible view count but low total score.
- C-developer-heavy dominated-by-one-platform examples: Ploy, smol machines, Drafted, Result, Hyper.
- C-developer-heavy high-views/low-score examples: Expanse (3849790 views, score 44), Kimpton AI (817687 views, score 39), Chronicle Labs (630232 views, score 43), jo (423376 views, score 33), Revnu (408117 views, score 44).
- C-developer-heavy high-GitHub/low-social examples: smol machines (3976 stars, score 67), Voquill (975 stars, score 51).
- C-developer-heavy viral-social/low-GitHub examples: HeyClicky (score 80), Ploy (score 67), Drafted (score 64), Result (score 63), Hyper (score 59).
- C-developer-heavy likely formula issues: Kimpton AI: large visible view count but low total score, Asendia AI: large visible view count but low total score, Interfaze: large visible view count but low total score, jo: large visible view count but low total score, TesterArmy: large visible view count but low total score.
- D-launch-attention dominated-by-one-platform examples: Ploy, smol machines, Drafted, Result, Hyper.
- D-launch-attention high-views/low-score examples: Kimpton AI (817687 views, score 40), Chronicle Labs (630232 views, score 45), jo (423376 views, score 33), Revnu (408117 views, score 45), TesterArmy (310352 views, score 42).
- D-launch-attention high-GitHub/low-social examples: smol machines (3976 stars, score 67), Voquill (975 stars, score 38).
- D-launch-attention viral-social/low-GitHub examples: HeyClicky (score 80), Ploy (score 67), Drafted (score 64), Result (score 63), Hyper (score 59).
- D-launch-attention likely formula issues: jo: large visible view count but low total score.
- F-browser-social-v2 dominated-by-one-platform examples: Ploy, smol machines, Drafted, Result, Gojiberry AI.
- F-browser-social-v2 high-views/low-score examples: Expanse (3849790 views, score 47), Kimpton AI (817687 views, score 46), Chronicle Labs (630232 views, score 49), jo (423376 views, score 33), TesterArmy (310352 views, score 46).
- F-browser-social-v2 high-GitHub/low-social examples: smol machines (3976 stars, score 67), Voquill (975 stars, score 35).
- F-browser-social-v2 viral-social/low-GitHub examples: HeyClicky (score 80), Ploy (score 67), Drafted (score 64), Result (score 63), Hyper (score 59).
- F-browser-social-v2 likely formula issues: jo: large visible view count but low total score.
- E-learned-tuned dominated-by-one-platform examples: HeyClicky, smol machines, Ploy, Result, Hyper.
- E-learned-tuned high-views/low-score examples: Kimpton AI (817687 views, score 40), Chronicle Labs (630232 views, score 43), jo (423376 views, score 33), Revnu (408117 views, score 44), TesterArmy (310352 views, score 47).
- E-learned-tuned high-GitHub/low-social examples: smol machines (3976 stars, score 67), Voquill (975 stars, score 36).
- E-learned-tuned viral-social/low-GitHub examples: HeyClicky (score 83), Ploy (score 66), Drafted (score 64), Result (score 62), Hyper (score 58).
- E-learned-tuned likely formula issues: Asendia AI: large visible view count but low total score, jo: large visible view count but low total score.

## Metric Sensitivity

- instagram A: HeyClicky 81, InsForge 70, sparse warnings 2, score 14.25.
- instagram B: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- instagram C: HeyClicky 81, InsForge 70, sparse warnings 2, score 14.25.
- instagram D: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- x A: HeyClicky 80, InsForge 69, sparse warnings 2, score 14.2.
- x B: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- x C: HeyClicky 80, InsForge 69, sparse warnings 2, score 14.2.
- linkedin A: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- linkedin B: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- linkedin C: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- github A: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- github B: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- github C: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- product_hunt A: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- product_hunt B: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- product_hunt C: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- youtube A: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- youtube B: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- youtube C: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.
- hacker_news A: HeyClicky 80, InsForge 70, sparse warnings 2, score 14.25.

Full machine-readable output: `outputs/scoring-experiments-s2026.json`.
