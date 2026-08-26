import {
  canonicalSocialAccountUrl,
  normalizeSocialAccountPlatform
} from "./social-account-url.mjs";

const LEGACY_IDENTITY_FIELDS = Object.freeze([
  "source_key",
  "entity_type",
  "entity_id",
  "platform",
  "url",
  "account_id"
]);

export function canonicalSocialAccountRowIdentity(row) {
  const platform = normalizeSocialAccountPlatform(row?.platform);
  const canonicalUrl = canonicalSocialAccountUrl(platform, row?.url);
  return platform && canonicalUrl ? `${platform}\u0000${canonicalUrl}` : null;
}

export function reconcileCanonicalSocialAccountRows(incomingRows, existingRows) {
  if (!Array.isArray(incomingRows) || !Array.isArray(existingRows)) {
    throw new TypeError("Canonical social account reconciliation requires incoming and existing row arrays.");
  }

  const existingBySourceKey = new Map();
  for (const existing of existingRows) {
    const sourceKey = cleanSourceKey(existing?.source_key);
    if (!sourceKey) continue;
    const previous = existingBySourceKey.get(sourceKey);
    if (previous && String(previous.id ?? "") !== String(existing.id ?? "")) {
      throw new Error(
        `Canonical social account source key ${sourceKey} resolves to multiple durable rows.`
      );
    }
    existingBySourceKey.set(sourceKey, existing);
  }

  const incomingIdentityBySourceKey = new Map();
  for (const incoming of incomingRows) {
    const sourceKey = requiredSourceKey(incoming);
    const identity = requiredCanonicalIdentity(incoming, sourceKey, "incoming");
    const previousIdentity = incomingIdentityBySourceKey.get(sourceKey);
    if (previousIdentity && previousIdentity !== identity) {
      throw new Error(
        `Canonical social account source key ${sourceKey} is assigned to multiple incoming identities.`
      );
    }
    incomingIdentityBySourceKey.set(sourceKey, identity);
  }

  return incomingRows.map((incoming) => {
    const sourceKey = requiredSourceKey(incoming);
    const existing = existingBySourceKey.get(sourceKey);
    if (!existing) return { ...incoming };

    const incomingIdentity = requiredCanonicalIdentity(incoming, sourceKey, "incoming");
    const existingIdentity = requiredCanonicalIdentity(existing, sourceKey, "durable");
    if (incomingIdentity !== existingIdentity) {
      throw new Error(
        `Canonical social account source key ${sourceKey} changed canonical identity; ` +
        "refusing to overwrite its durable account row."
      );
    }

    const reconciled = { ...incoming };
    for (const field of LEGACY_IDENTITY_FIELDS) {
      if (!Object.hasOwn(existing, field)) {
        throw new Error(
          `Canonical social account source key ${sourceKey} is missing durable identity field ${field}.`
        );
      }
      reconciled[field] = existing[field];
    }
    return reconciled;
  });
}

function cleanSourceKey(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredSourceKey(row) {
  const sourceKey = cleanSourceKey(row?.source_key);
  if (!sourceKey) throw new Error("Canonical social account row is missing a source key.");
  return sourceKey;
}

function requiredCanonicalIdentity(row, sourceKey, kind) {
  const identity = canonicalSocialAccountRowIdentity(row);
  if (!identity) {
    throw new Error(
      `Canonical social account source key ${sourceKey} has an invalid ${kind} platform or URL.`
    );
  }
  return identity;
}
