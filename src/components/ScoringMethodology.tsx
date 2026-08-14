import type { ScoringContext } from "@/lib/graph/types";
import { buildScoringMethodologyPresentation } from "@/lib/scoring/presentation";

export interface ScoringMethodologyProps {
  currentModel?: ScoringContext;
}

/**
 * Model-governance copy intentionally contains no duplicated scoring constants.
 * The deterministic scorer remains the production baseline, while learned-model claims stay
 * blocked until the versioned research acceptance artifact clears every gate.
 */
export function ScoringMethodology({ currentModel }: ScoringMethodologyProps) {
  const baseline = buildScoringMethodologyPresentation();
  const modelLabel = currentModel
    ? `${currentModel.modelName} · ${currentModel.modelId} v${currentModel.modelVersion}`
    : "Deterministic traction baseline";

  return (
    <section className="scoring-methodology" aria-labelledby="scoring-methodology-title">
      <header>
        <div>
          <h2 id="scoring-methodology-title">Scoring model status and methodology</h2>
          <p>{modelLabel}</p>
        </div>
        <span className="scoring-model-status">V5 learned model: rejected — insufficient data</span>
      </header>

      <div className="scoring-methodology-notice" role="status">
        <strong>The learned scorer has not been promoted.</strong>
        <p>
          The score currently visible in the graph is the production deterministic index and rollback baseline. It
          is not a calibrated probability, a causal estimate, or a learned prediction of company quality. V5 will
          replace it only after compatible longitudinal data, leakage-safe held-out evaluation, calibration,
          reproducibility, subgroup, and runtime-parity gates all pass.
        </p>
        <p>
          V5 validated platform coverage is currently none: every platform remains v4-only until it has enough
          compatible, licensed, longitudinal examples to clear the same held-out acceptance gate. An unsupported V5
          row is unscored rather than routed through another platform&apos;s parameters.
        </p>
      </div>

      <details className="scoring-baseline-interpreter yc-favorite-methodology">
        <summary>How YC partner Favorite scores are calculated</summary>
        <div className="scoring-baseline-content">
          <p>
            Favorite score is a separate 1–100 signal about the conviction a YC partner expresses toward any startup
            in the selected batch. It uses already-ingested public commentary. Explicit superlatives, strong
            endorsements, and specific reasoning about a team, market, product, or technology carry much more weight
            than a short tag or congratulations.
          </p>
          <p>
            The strongest attributable statement sets the pair&apos;s foundation. Additional independent posts add a
            bounded, diminishing-return bonus, and duplicate or cross-posted copies count once. Skeptical language can
            reduce the result. The score does not measure company quality, investment merit, ordinary traction, or
            the number of posts by itself.
          </p>
          <p>
            Confidence is separate from Favorite score. It reflects unique supporting posts, independent contexts,
            platform breadth, attribution quality, date completeness, and verified source links. No commentary is not
            treated as evidence of dislike; it simply produces no attributable ranking signal.
          </p>
        </div>
      </details>

      <details className="scoring-baseline-interpreter">
        <summary>How the currently displayed deterministic baseline is calculated</summary>
        <div className="scoring-baseline-content">
          <p>
            This explains {baseline.modelId} v{baseline.modelVersion}, not the intended learned V5 formula. The model
            starts with verified native evidence whose configured visible metrics are normalized
            to canonical aliases. It maps each raw count through the table value, then applies a platform-specific
            logarithmic reference. The current monotonic patch uses {baseline.evidenceBlend.absolutePercent}%
            reference-anchored absolute signal and {baseline.evidenceBlend.platformMidrankPercent}% evidence-level
            cohort midrank, so changing one row cannot lower an unchanged same-platform peer.
          </p>
          <p>
            Publication date and post age do not raise or lower an evidence score: identical visible metrics receive
            the same score regardless of when they were published. Duplicate physical posts count once; only the
            strongest {baseline.postSlotPercents.length} posts per platform contribute, at {" "}
            {baseline.postSlotPercents.join("%, ")}% by slot. Posts are therefore not simply summed without limit.
          </p>
          <p>
            Platform results use the fixed configured shares below. A platform with no eligible evidence contributes
            zero at its configured share; present platforms are never renormalized to fill the missing weight. Breadth
            is not a separate bonus ({baseline.platformBlend.strongestPercent}% strongest-platform blend and {" "}
            {baseline.platformBlend.diversifiedPercent}% fixed-share blend). That raw absolute score remains the
            auditable benchmark input ({baseline.calibration.absolutePercent}% absolute and {" "}
            {baseline.calibration.cohortPercentilePercent}% cohort-percentile signal). The displayed headline uses one
            ratio shared by every supported batch: the strongest current company&apos;s absolute score maps to 100 and
            every other company receives the same global calibration. There is no per-batch min/max stretch, and
            platform visibility filters never recompute this canonical factor.
          </p>

          <div className="scoring-baseline-table-wrap">
            <table>
              <caption>V4 configured platform, reference, and raw metric weights</caption>
              <thead>
                <tr>
                  <th scope="col">Platform</th>
                  <th scope="col">Share</th>
                  <th scope="col">Log reference</th>
                  <th scope="col">Raw metric weights before normalization</th>
                </tr>
              </thead>
              <tbody>
                {baseline.platformWeights.map(({ platform, percent }) => {
                  const reference = baseline.platformReferences.find((row) => row.platform === platform);
                  const metrics = baseline.metricWeights.find((row) => row.platform === platform)?.metrics ?? [];
                  return (
                    <tr key={platform}>
                      <th scope="row">{formatPlatform(platform)}</th>
                      <td>{percent}%</td>
                      <td>{reference?.highEngagement.toLocaleString() ?? "—"}</td>
                      <td>{metrics.map(({ metric, weight }) => `${metric} × ${weight}`).join(" · ") || "None"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p>
            V4 confidence is separate from score: its heuristic starts at {baseline.confidence.basePercent}%, then
            uses evidence depth ({baseline.confidence.evidenceDepthPercent}%, scale {baseline.confidence.evidenceDepthScale}),
            platform breadth ({baseline.confidence.platformBreadthPercent}%), publication-date coverage ({" "}
            {baseline.confidence.publicationDatePercent}%), and verified links ({baseline.confidence.verifiedLinkPercent}%).
            Medium/high labels begin at {baseline.confidence.mediumThresholdPercent}%/{baseline.confidence.highThresholdPercent}%.
            Publication-date coverage affects this separate confidence metadata, never the score. These weights,
            references and slot shares are product heuristics; they are not fitted V5 parameters.
          </p>
        </div>
      </details>

      <div className="scoring-methodology-grid">
        <MethodQuestion title="1. What does the displayed score measure?">
          V4 summarizes verified, visible platform-native traction evidence on a bounded 0–100 index. The proposed
          V5 target is a pre-registered future platform-native performance outcome observed after a genuine t0
          measurement; it will be labeled as a probability or percentile only if held-out calibration supports that
          interpretation.
        </MethodQuestion>

        <MethodQuestion title="2. Which research and datasets support V5?">
          The versioned source registry separates incorporated, rejected, unavailable, and license-restricted
          benchmarks. Citation alone does not count as incorporation: data, protocol, baseline, failure-mode test, or
          acceptance gate must actually enter the reproducible pipeline.
        </MethodQuestion>

        <MethodQuestion title="3. How are train, validation, and test separated?">
          The pre-registered design keeps canonical physical posts in one split, places training before validation and
          validation before final test, and reserves an entity holdout for future unseen-company evaluation. Planned
          leave-one-batch-out checks are separate development analyses. The current rejected artifact has no rows, so it
          reports no unseen-company or unseen-batch result and the final test has not selected a model.
        </MethodQuestion>

        <MethodQuestion title="4. How are likes, comments, reposts, views, stars, and forks used?">
          V5 candidates use only features genuinely available at the observation timestamp, including missingness and
          post age. Separate native signals are not collapsed with a hand-selected exchange rate. Monotonic candidates
          ensure that increasing a genuine positive signal cannot lower a prediction. Signal-family ablations remain a
          held-out acceptance requirement; none is reported for the current zero-row rejected artifact.
        </MethodQuestion>

        <MethodQuestion title="5. Are there fixed coefficients or additive post slots?">
          No hand-picked coefficient or top-post slot vector is accepted for V5. Linear coefficients, spline effects,
          calibration maps, temporal curves, and company pooling parameters must be fitted under the frozen search
          protocol and survive held-out evaluation. Nonlinear marginal effects depend on platform, age, and context.
        </MethodQuestion>

        <MethodQuestion title="6. Does posting on multiple platforms help?">
          V5 does not assume that platform breadth is beneficial. Cross-platform combination must be learned and
          validated, or platform scores remain separate. Coverage may narrow uncertainty without secretly adding score
          points. Visibility filters never recompute a canonical score.
        </MethodQuestion>

        <MethodQuestion title="7. Is there a maximum and does recency affect the score?">
          The displayed deterministic index is bounded from 0 to 100. Publication date and post age do not affect its
          score, so an older post is not discounted and a newer post receives no freshness bonus. Date completeness may
          be reported separately as confidence metadata. Any future learned age effect would require its own held-out
          validation before it could change a score.
        </MethodQuestion>

        <MethodQuestion title="8. How is uncertainty represented?">
          Score, predictive uncertainty, evidence coverage, link verification, date quality, and source reliability are
          separate fields. A completeness heuristic is never called a statistical interval. Unsupported platforms and
          out-of-distribution inputs remain visibly unscored.
        </MethodQuestion>

        <MethodQuestion title="9. What are the known limitations?">
          Public engagement is selected, platform-dependent, missing-not-at-random, and potentially manipulated. The
          model does not establish causality, company quality, valuation, or investment outcomes. Fairness and transfer
          claims are limited to the subgroups and platforms actually tested.
        </MethodQuestion>

        <MethodQuestion title="10. What do map lines mean, and do they affect score?">
          Lines explain only the relationship types present in the map, such as shared industry context or a shared
          group partner. They do not imply company interaction and never add score points. The map legend exposes the
          exact relationship explanations available in this graph.
        </MethodQuestion>
      </div>

      <p className="scoring-disclaimer">
        A future accepted V5 artifact will state: “The parameters were fitted on versioned benchmark and longitudinal
        data under a frozen evaluation protocol. They are predictive associations for the stated target, not causal
        estimates of company quality or investment outcomes.” Until that gate passes, the product makes no such fitted
        model claim.
      </p>
    </section>
  );
}

function MethodQuestion({ title, children }: { title: string; children: string }) {
  return (
    <article>
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}

function formatPlatform(platform: string): string {
  const labels: Record<string, string> = {
    github: "GitHub",
    x: "X",
    linkedin: "LinkedIn",
    instagram: "Instagram",
    product_hunt: "Product Hunt",
    youtube: "YouTube",
    hacker_news: "Hacker News",
    reddit: "Reddit",
    bilibili: "Bilibili"
  };
  return labels[platform] ?? platform;
}
