import type { V5InputManifest, V5ResearchRegistry } from "./types";

const DATASET_DECISIONS = new Set(["accepted_dataset"]);

export function validateTrainingSourcesAgainstRegistry(
  manifest: V5InputManifest,
  registry: V5ResearchRegistry
): void {
  if (!registry || typeof registry !== "object" || !Array.isArray(registry.sources)) {
    throw new Error("The scoring research registry is missing or invalid.");
  }
  const byId = new Map(registry.sources.map((source) => [source.id, source]));
  for (const source of manifest.sources.filter((candidate) => candidate.status === "accepted")) {
    const registered = byId.get(source.id);
    if (!registered) {
      throw new Error(`Accepted training source is absent from the research registry: ${source.id}`);
    }
    if (!DATASET_DECISIONS.has(registered.decision.status)) {
      throw new Error(
        `Research registry does not permit ${source.id} as a training dataset (${registered.decision.status}).`
      );
    }
    if (
      registered.incorporation.state !== "implemented" ||
      registered.incorporation.implementation_evidence.length === 0
    ) {
      throw new Error(`Research registry does not record implemented incorporation for ${source.id}.`);
    }
    if (registered.citation.trim() !== source.citation.trim()) {
      throw new Error(`Training manifest citation does not match the research registry for ${source.id}.`);
    }
    const registeredArtifact = registered.training_artifact;
    if (!registeredArtifact) {
      throw new Error(`Research registry does not bind an exact training artifact for ${source.id}.`);
    }
    if (
      registeredArtifact.sha256 !== source.sha256 ||
      registeredArtifact.source_revision !== source.sourceRevision ||
      registeredArtifact.accessed_at !== source.accessedAt ||
      registeredArtifact.license.id !== source.license.id ||
      registeredArtifact.license.permitsResearchUse !== source.license.permitsResearchUse ||
      registeredArtifact.license.redistribution !== source.license.redistribution
    ) {
      throw new Error(`Training manifest artifact identity does not match the research registry for ${source.id}.`);
    }
  }
}
