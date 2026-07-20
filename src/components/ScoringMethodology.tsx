import type { ScoringContext } from "@/lib/graph/types";
import { buildScoringMethodologyPresentation } from "@/lib/scoring/presentation";

export interface ScoringMethodologyProps {
  currentModel?: ScoringContext;
}

/**
 * Model-governance copy intentionally contains no duplicated scoring constants.
 * V4 remains available as a frozen baseline, while learned-model claims stay
 * blocked until the versioned research acceptance artifact clears every gate.
 */
export function ScoringMethodology({ currentModel }: ScoringMethodologyProps) {
  const baseline = buildScoringMethodologyPresentation();
  const modelLabel = currentModel
    ? `${currentModel.modelName} · ${currentModel.modelId} v${currentModel.modelVersion}`
    : "Frozen v4 traction baseline";

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
          The score currently visible in the graph is the immutable v4 deterministic index and rollback baseline. It
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

      <details className="scoring-baseline-interpreter">
        <summary>How the currently displayed V4 baseline is calculated</summary>
        <div className="scoring-baseline-content">
          <p>
            This is a historical-score interpreter for {baseline.modelId} v{baseline.modelVersion}, not the intended
            learned V5 formula. V4 starts with verified native evidence whose configured visible metrics are normalized
            to canonical aliases. It multiplies each raw count by the table value, applies a platform-specific
            logarithmic reference, and blends {baseline.evidenceBlend.absolutePercent}% absolute signal with {" "}
            {baseline.evidenceBlend.platformMidrankPercent}% within-platform midrank.
          </p>
          <p>
            Evidence then blends {baseline.recencyBlend.durablePercent}% durable signal with {" "}
            {baseline.recencyBlend.momentumPercent}% recency momentum. A missing publication date uses the historical
            momentum value {baseline.recencyBlend.missingDateMomentum}. Duplicate physical posts count once; only the
            strongest {baseline.postSlotPercents.length} posts per platform contribute, at {" "}
            {baseline.postSlotPercents.join("%, ")}% by slot. Posts are therefore not simply summed without limit.
          </p>
          <p>
            Platform results use the configured platform shares below; breadth is not a separate bonus in this V4
            configuration ({baseline.platformBlend.strongestPercent}% strongest-platform blend and {" "}
            {baseline.platformBlend.diversifiedPercent}% configured diversified blend). Company calibration blends {" "}
            {baseline.calibration.absolutePercent}% absolute score with {" "}
            {baseline.calibration.cohortPercentilePercent}% tie-aware cohort percentile, then stretches the positive
            company cohort across the 1–100 range (companies without eligible evidence remain 0). Filters only change
            visibility and never recompute this canonical result.
          </p>

          <div className="scoring-baseline-table-wrap">
            <table>
              <caption>V4 configured platform, reference, and raw metric weights</caption>
              <thead>
                <tr>
                  <th scope="col">Platform</th>
                  <th scope="col">Share</th>
                  <th scope="col">Log reference</th>
                  <th scope="col">Half-life</th>
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
                      <td>{reference ? `${reference.halfLifeDays} days` : "—"}</td>
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
            These weights, references, half-lives, slot shares, missing-date behavior, and calibration blend are
            product heuristics preserved only for V4 history and rollback; they are not fitted V5 parameters.
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

        <MethodQuestion title="5. Are there fixed multipliers or additive post slots?">
          No hand-picked multiplier or top-post slot vector is accepted for V5. Linear coefficients, spline effects,
          calibration maps, temporal curves, and company pooling parameters must be fitted under the frozen search
          protocol and survive held-out evaluation. Nonlinear marginal effects depend on platform, age, and context.
        </MethodQuestion>

        <MethodQuestion title="6. Does posting on multiple platforms help?">
          V5 does not assume that platform breadth is beneficial. Cross-platform combination must be learned and
          validated, or platform scores remain separate. Coverage may narrow uncertainty without secretly adding score
          points. Visibility filters never recompute a canonical score.
        </MethodQuestion>

        <MethodQuestion title="7. Is there a maximum and how is recency handled?">
          Any promoted output will document its bounds and exact semantics. A future frozen search may compare
          recency-free and learned age-effect candidates, but the current rejected artifact fitted no temporal curve.
          No manually chosen half-life or guessed missing-date prior is permitted. Unknown publication dates remain
          unscored unless a separately validated path exists.
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
