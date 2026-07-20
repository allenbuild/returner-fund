# Scoring research source registry

Research cutoff: **2026-07-20**
Access date for every source: **2026-07-20**
Machine-readable record: [`source-registry.json`](./source-registry.json)

## Bottom line

No paper supplies defensible universal exchange rates among likes, comments, reposts, views, stars, or forks. The relevant literature instead supports an experimental design: define a platform-native future outcome, preserve a strict observation cutoff, split forward in time and by entity, compare transparent and cascade-aware baselines only when their inference features exist, calibrate outside the final test set, and report ranking, calibration, uncertainty, and subgroup behavior separately.

No external source is marked as incorporated. “Accepted protocol” means only that a protocol element is scientifically relevant. It does **not** mean that data, code, fitted parameters, or a model from that source have been used. A source can be promoted to incorporated only when the registry can cite a repository path, test, training manifest, or evaluation artifact that proves the exact use.

The strongest external acquisition candidate is [GH Archive](https://www.gharchive.org/) for a GitHub-only longitudinal task. Even that source is conditional: an accepted extraction still needs legal review, an exact list and SHA-256 for every hourly object, schema-drift handling, canonical repository identity, deletion/rename policy, and chronological plus unseen-repository tests.

The screened Reddit datasets are not admissible for production training. The current [Reddit Data API Terms](https://redditinc.com/policies/data-api-terms) state that API User Content may not be used to train an ML/AI model without express rightsholder permission. Dataset-repository labels cannot silently override platform or content rights.

## Decision summary

| Decision | Count | Meaning |
|---|---:|---|
| Accepted protocol | 11 | A target, split, metric, calibration, monotonicity, or uncertainty lesson is defensible; nothing is yet implemented. |
| Conditional dataset | 1 | GH Archive may be acquired only after the documented legal, hashing, identity, and leakage gates. |
| Conditional method | 1 | XGBoost is a candidate family only after a pinned deterministic build and held-out acceptance tests. |
| Rejected dataset | 9 | Current target, features, access, license/terms, or split make the source inadmissible for production training. |
| Screen only | 3 | Relevant context, but evidence or reproducibility is insufficient for a stronger decision. |

## Source-by-source decisions

| Source | Platform / task | Data and license status | Decision | Exact incorporation |
|---|---|---|---|---|
| [RecSys Challenge 2020](https://recsys.acm.org/recsys20/challenge/) and [overview](https://arxiv.org/abs/2004.13715) | Twitter reader–Tweet probabilities for like, reply, retweet, and quote; about 160M train plus 40M validation/test examples | Historical, deletion-synchronized release; no current immutable licensed revision verified | Rejected dataset | None. Its temporal split and per-label evaluation remain protocol candidates only. |
| [RecSys Challenge 2021](https://recsys.acm.org/recsys21/challenge/) and [overview](https://doi.org/10.1145/3487572.3487573) | Twitter reader–Tweet engagement, about 1B records, with producer-follower fairness | Historical challenge-gated release; no durable dataset license verified | Rejected dataset | None. Author-audience stratification is proposed as a diagnostic, not implemented. |
| [SEISMIC](https://www.statslab.cam.ac.uk/~qz280/publication/seismic/) | Twitter final 14-day retweet-cascade size from timestamped reshares and resharing-user reach | Paper/code page public; reusable dataset license not verified | Accepted protocol | None. Candidate lessons: explicit t0/t1, forward-time test, rank correlation, and top-k coverage. Fitted constants and the hand-selected 15-Tweet kernel sample are not accepted. |
| [Feature Driven and Point Process Approaches](https://arxiv.org/abs/1608.04862) | Twitter final cascade size and cascade-doubling tasks | Author code exists; current licensed benchmark artifacts not verified | Accepted protocol | None. Candidate lesson: compare transparent features with point processes and use a calendar split. |
| [DeepCas](https://doi.org/10.1145/3038912.3052643) | Twitter/AMiner future cascade increment from cascade graphs | Paper is CC BY 4.0; Twitter Decahose data is not a public licensed benchmark | Accepted protocol | None. Future-increment labels and temporal partitions are candidates; the model is feature-incompatible. |
| [DeepHawkes](https://doi.org/10.1145/3132847.3132973) and [author repository](https://github.com/CaoQi92/DeepHawkes) | Weibo/APS cascade prediction from diffusion paths and learned user influence | Public repository has no verified license file; external data host and platform rights unresolved | Rejected dataset | None. Keep only as a named baseline that must be rejected when event paths are absent. |
| [Continuous-Time Graph Learning](https://www.ijcai.org/proceedings/2023/247) | Twitter/Weibo/APS incremental cascade popularity using global user/cascade states | No unified licensed data/code release verified | Rejected dataset | None. Random 70/15/15 splitting and identity-bearing state violate this product’s gates. |
| [ConCat](https://doi.org/10.1109/TKDE.2025.3583129) | Neural ODE/point-process cascade forecasting | Paper available; exact code, split, and dataset licenses not verified | Screen only | None. Operationally incompatible without event-level cascade histories. |
| [Reddit-V](https://aclanthology.org/2025.ranlp-1.41/) and [repository](https://github.com/EL-Amrany/Reddit-V) | 27,587 Reddit posts; pre-engagement text/image virality classification | Repository has no verified license; no fixed t1 horizon; Reddit training rights unresolved | Rejected dataset | None. |
| [PoPreRo](https://arxiv.org/abs/2407.04541) and [repository](https://github.com/ana-rogoz/PoPreRo) | 28,107 Romanian Reddit posts; binary snapshot popularity | README says CC BY-NC-SA 4.0; non-commercial restriction and Reddit rights are incompatible with production use | Rejected dataset | None. Subreddit holdout is informative but not adopted. |
| [MMG-Pop](https://arxiv.org/abs/2606.27539) | Bluesky/Reddit, six future cascade outcomes at short observation windows and 4/8/16/24-hour horizons | June 2026 preprint; no verified released code/data license; random 80/10/10 split | Rejected dataset | None. Fixed-horizon comparisons are protocol candidates only. |
| [Predicting the Popularity of GitHub Repositories](https://arxiv.org/abs/1607.04342) | Future stars and rank for 4,248 already-popular repositories | Reconstructible in principle; original sample/code not released as a current benchmark | Accepted protocol | None. Supports a distinct future-star target and rank metrics, not its coefficients or biased sample. |
| [GH Archive](https://www.gharchive.org/) | Hourly public GitHub event archive | Public JSON/BigQuery access; no blanket data license on landing page; historical deletions may persist | Conditional dataset | None. No object was acquired for training in this research lane. |
| [GHTorrent](https://github.com/ghtorrent/ghtorrent.org/blob/master/index.md) | Historical queryable GitHub mirror | Current pinned dump, coverage, and blanket mirrored-data license not verified | Screen only | None. Possible metadata supplement after independent verification. |
| [Can Cascades be Predicted?](https://arxiv.org/abs/1403.4608) | Facebook relative growth, cascade doubling, and matched-content comparison | Proprietary data unavailable | Accepted protocol | None. Relative-growth and matched-content error analysis are candidates only. |
| [LambdaMART overview](https://www.microsoft.com/en-us/research/publication/from-ranknet-to-lambdarank-to-lambdamart-an-overview/) | General learning-to-rank | Open technical report; implementation license depends on selected library | Accepted protocol | None. Ranking comparison only; it cannot make an uncalibrated rank score a probability. |
| [Guo et al. calibration](https://proceedings.mlr.press/v70/guo17a.html) | Post-hoc probability calibration | Open PMLR paper | Accepted protocol | None. Candidate requirement: calibration fit outside final test and assessed with reliability metrics. |
| [Niculescu-Mizil and Caruana](https://doi.org/10.1145/1102351.1102430) | Platt versus isotonic calibration | ACM paper; standard implementations available | Accepted protocol | None. Requires a preregistered held-out comparison; isotonic is not automatically preferred. |
| [Conformal prediction tutorial](https://arxiv.org/abs/2107.07511) | Distribution-free uncertainty under exchangeability | Open preprint and educational code | Accepted protocol | None. Naive random split conformal is rejected under leaderboard drift. |
| [Online conformal prediction](https://proceedings.mlr.press/v235/angelopoulos24a.html) | Sequential coverage under drift | Open peer-reviewed PMLR paper | Accepted protocol | None. Candidate only if delayed outcomes provide a large enough chronological stream. |
| [XGBoost paper](https://doi.org/10.1145/2939672.2939785) | Regularized boosted trees for tabular prediction/ranking | Apache-2.0 current implementation; no version selected here | Conditional method | None. Requires pinned CPU settings, exact feature order, parity tests, and held-out superiority over simpler models. |
| [XGBoost monotonic constraints](https://xgboost.readthedocs.io/en/stable/tutorials/monotonic.html) | Hard monotonic feature constraints | Official maintained documentation | Accepted protocol | None. Candidate requirement: constraints plus independent perturbation tests. |
| [Reddit Data API Terms](https://redditinc.com/policies/data-api-terms) | Legal/access gate | Effective 2025-06-28 | Rejected dataset | None in model code. This source changes Reddit dataset-screening decisions to rejected absent further permission. |
| [Twitter/X RecSys 2020 retrospective](https://blog.x.com/engineering/en_us/topics/insights/2020/what_twitter_learned_from_recsys2020) | Official challenge retrospective | Web article, not a dataset grant | Rejected dataset | None. Adversarial-validation guidance remains a proposed check. |
| MMG-Pop’s DeepCas/DeepHawkes cross-benchmark, in the [same preprint](https://arxiv.org/abs/2606.27539) | Bluesky/Reddit transfer comparison | Unreviewed, no verified artifact | Screen only | None. It is negative transfer evidence, not a production selection result. |

## Concrete scientific findings

### 1. RecSys 2020/2021 cannot supervise aggregate post performance

The RecSys rows predict whether one specified reader engages with one candidate Tweet. They include reader features, a reader-author relationship, an exposure sampling process, and pseudo-negatives. This repository ranks physical posts and companies without reader/exposure context. Treating the challenge labels as aggregate popularity would change the estimand and create an inference-schema mismatch. Separate engagement labels and forward-time validation are useful; pretrained coefficients or a challenge winner are not.

### 2. Cascade papers require cascade data

SEISMIC, DeepCas, DeepHawkes, CTCP, and ConCat depend on some combination of individual reshare/reply times, resharer identities or follower counts, diffusion paths, conversation graphs, and historical user state. Aggregate snapshots such as “127 reposts observed at 10:00” cannot reconstruct those event sequences. A cascade model must therefore be rejected cleanly when inference-time cascade features do not exist; it must not be fed invented timings or graph edges.

SEISMIC’s temporal experiment is nevertheless unusually useful: the first seven days form training, the next eight days form test, and a further 14 days allow outcomes to mature. It evaluates absolute error, Kendall rank correlation, and top-k breakout coverage. These are protocol lessons, not transferable decay constants.

DeepCas also provides a useful incremental target: predict future growth after an explicit prefix instead of predicting a same-time total from that same total. Its Twitter experiment is separated by original-post date. Conversely, CTCP and MMG-Pop use random cascade splits, which are inadequate where users, companies, or time regimes can repeat.

### 3. GitHub needs its own target

Stars, forks, issues, pushes, and releases represent different behaviors and must not be hand-weighted into one synthetic outcome. The Borges et al. paper supports forecasting future stars as a distinct adoption target and evaluating ranks, but its sample starts from the top 5,000 repositories and excludes young/newcomer behavior. It is not representative of accelerator companies.

GH Archive can reconstruct timestamped native events from 2011 onward (Events API data from 2015 onward). A valid extraction should choose one target at a time—for example, future new stars over a preregistered horizon—then use only events known at t0. Repository renames, transfers, forks, deletions, bots, and events missing from the public timeline need explicit policies. The final test must be later in calendar time and include unseen repositories or organizations.

### 4. Calibration and ranking answer different questions

LambdaMART can optimize ordering metrics, but its raw scores are not probabilities. A UI may say “probability of reaching the preregistered high-performance outcome” only after a separately fit calibrator passes held-out reliability checks. Otherwise the output must be labeled as a rank score or percentile.

No calibrator is automatically best. The accepted protocol is to fit candidate sigmoid/Platt, isotonic, or temperature methods on validation or out-of-fold predictions only; compare them with no calibration using log loss/Brier-style probability quality and reliability plots; and touch the final test once after model and calibrator selection are frozen. Small platform strata may make isotonic calibration unstable.

Conformal intervals provide marginal coverage only under their assumptions. Ordinary split conformal’s exchangeability is questionable in a changing leaderboard. Online conformal is more relevant to drift, but it still needs enough delayed outcomes, explicit chronological evaluation, coverage by platform, and interval-width reporting. Coverage does not establish probability calibration.

### 5. Monotonicity is a constraint, not a coefficient source

Official XGBoost documentation confirms hard increasing/decreasing feature constraints. If a tree candidate is used, genuine additional likes, comments, and reshares can be constrained not to lower the predicted outcome, while age alone must not masquerade as engagement. The exact trained artifact still needs exhaustive counterfactual perturbation tests. Constraints neither detect purchased engagement nor prove generalization.

## Dataset-promotion gate

Before any registry row becomes “incorporated,” its owning lane must add all of the following evidence:

1. A legally reviewed access basis, dataset license/terms snapshot, and redistribution decision.
2. A fetch/reconstruction manifest with exact URLs or object names, access timestamp, revision/ETag where available, byte size, and SHA-256.
3. A schema map proving that every training feature exists at production observation time.
4. A target map proving that t0 features precede a meaningful t1 outcome and that incomplete horizons are censored or excluded consistently.
5. Canonical physical-post/repository identity and a duplicate-group report.
6. Forward-time train, validation, and one-touch final-test partitions, plus unseen-entity evaluation.
7. A deletion/private/missing-record policy and an audit of selection, survival, exposure, and missing-not-at-random bias.
8. A repository path to the implemented protocol/baseline or a model manifest proving actual data use.

Until those artifacts exist, the correct `incorporation.state` remains `registry_only`.

## Provenance notes

The machine-readable registry records exact source revisions where visible, current GitHub commit SHAs for PoPreRo, Reddit-V, and DeepHawkes, and SHA-256 hashes for the primary PDFs downloaded during review. No downloaded raw benchmark dataset was added to the repository. Restricted or ambiguously licensed content must remain out of version control.

The review uses primary papers, official proceedings, author repositories, official project pages, and official platform terms. It does not treat a leaderboard result, repository README, or paper bibliography as proof of cross-platform transfer.
