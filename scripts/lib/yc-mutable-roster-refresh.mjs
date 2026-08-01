import * as defaultFs from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PLATFORM_KEYS = ["github", "instagram", "linkedin", "x", "youtube"];

/**
 * Derive immutable-ID-backed mutable identity transitions without discarding
 * any historical account lineage already recorded in the alias ledger.
 */
export function reconcileMutableYcRoster({ previousCatalog, nextCatalog, aliasLedger }) {
  const previous = validateCatalog(previousCatalog, "existing YC catalog");
  const next = validateCatalog(nextCatalog, "fresh YC catalog");
  const reconciled = structuredClone(validateAliasLedger(aliasLedger));
  const previousById = new Map(previous.map((company) => [company.id, company]));
  const appended = [];
  const appendedFounderTransitions = [];

  for (const company of next) {
    const former = previousById.get(company.id);
    if (!former) continue;

    const founderTransitions = deriveFounderTransitions(former, company);
    for (const transition of founderTransitions) {
      if (!hasFounderTransition(reconciled.founderTransitions ?? [], transition)) {
        (reconciled.founderTransitions ??= []).push(transition);
        appendedFounderTransitions.push(transition);
      }
    }

    if (former.slug === company.slug && former.name === company.name) continue;

    const transition = {
      companyId: company.id,
      fromSlug: former.slug,
      fromName: former.name,
      toSlug: company.slug,
      toName: company.name,
      companyAccounts: normalizeAccounts(former.socialLinks),
      founders: former.founders.map((founder) => {
        const currentFounder = company.founders.find((candidate) => candidate.id === founder.id);
        return {
          founderId: founder.id,
          name: founder.name,
          ...(currentFounder && currentFounder.name !== founder.name
            ? { toName: currentFounder.name }
            : {}),
          accounts: normalizeAccounts(founder.socialLinks)
        };
      })
    };

    reconciled.aliases.push(transition);
    appended.push(transition);
  }

  validateAliasLedger(reconciled, next);
  return { aliasLedger: reconciled, appended, appendedFounderTransitions };
}

/**
 * Publish the catalog and alias ledger as a transaction. Both complete files
 * are staged and parsed before replacement. If either replacement fails, any
 * already-replaced file is restored byte-for-byte from its private backup.
 */
export async function publishCatalogAndAliasLedger({
  catalogPath,
  aliasLedgerPath,
  catalog,
  aliasLedger,
  fs = defaultFs
}) {
  const resolvedCatalogPath = resolve(catalogPath);
  const resolvedAliasPath = resolve(aliasLedgerPath);
  if (resolvedCatalogPath === resolvedAliasPath) {
    throw new Error("Catalog and alias-ledger paths must be different files.");
  }

  // Validate the complete state before doing any filesystem mutation.
  validateCatalog(catalog, "fresh YC catalog");
  validateAliasLedger(aliasLedger, catalog.companies);

  const [originalCatalog, originalAliases] = await Promise.all([
    fs.readFile(resolvedCatalogPath),
    fs.readFile(resolvedAliasPath)
  ]);
  const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;
  const aliasText = `${JSON.stringify(aliasLedger, null, 2)}\n`;
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const catalogTemp = `${resolvedCatalogPath}.${nonce}.tmp`;
  const aliasTemp = `${resolvedAliasPath}.${nonce}.tmp`;
  const catalogBackup = `${resolvedCatalogPath}.${nonce}.backup`;
  const aliasBackup = `${resolvedAliasPath}.${nonce}.backup`;
  const cleanupPaths = [catalogTemp, aliasTemp, catalogBackup, aliasBackup];
  let catalogReplaced = false;
  let aliasesReplaced = false;

  await Promise.all([
    fs.mkdir(dirname(resolvedCatalogPath), { recursive: true }),
    fs.mkdir(dirname(resolvedAliasPath), { recursive: true })
  ]);

  try {
    await Promise.all([
      fs.writeFile(catalogTemp, catalogText, { encoding: "utf8", flag: "wx" }),
      fs.writeFile(aliasTemp, aliasText, { encoding: "utf8", flag: "wx" }),
      fs.writeFile(catalogBackup, originalCatalog, { flag: "wx" }),
      fs.writeFile(aliasBackup, originalAliases, { flag: "wx" })
    ]);

    // Catch serialization or staging corruption before replacing either file.
    const [stagedCatalog, stagedAliases] = await Promise.all([
      readJson(catalogTemp, "staged YC catalog", fs),
      readJson(aliasTemp, "staged YC alias ledger", fs)
    ]);
    validateCatalog(stagedCatalog, "staged YC catalog");
    validateAliasLedger(stagedAliases, stagedCatalog.companies);

    await fs.rename(catalogTemp, resolvedCatalogPath);
    catalogReplaced = true;
    await fs.rename(aliasTemp, resolvedAliasPath);
    aliasesReplaced = true;
  } catch (error) {
    const rollbackErrors = [];
    if (catalogReplaced) {
      try {
        await fs.rename(catalogBackup, resolvedCatalogPath);
        catalogReplaced = false;
      } catch (rollbackError) {
        rollbackErrors.push(`catalog rollback failed: ${errorMessage(rollbackError)}`);
      }
    }
    if (aliasesReplaced) {
      try {
        await fs.rename(aliasBackup, resolvedAliasPath);
        aliasesReplaced = false;
      } catch (rollbackError) {
        rollbackErrors.push(`alias-ledger rollback failed: ${errorMessage(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors.map((message) => new Error(message))],
        `YC roster transaction failed and could not be fully rolled back: ${errorMessage(error)}`
      );
    }
    throw error;
  } finally {
    await Promise.allSettled(cleanupPaths.map((path) => fs.rm(path, { force: true })));
  }
}

export async function readJson(path, label, fs = defaultFs) {
  let text;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${label} at ${path}: ${errorMessage(error)}`, {
      cause: error
    });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse ${label} at ${path}: ${errorMessage(error)}`, {
      cause: error
    });
  }
}

export function validateAliasLedger(aliasLedger, currentCompanies = null) {
  if (!aliasLedger || typeof aliasLedger !== "object" || !Number.isInteger(aliasLedger.version)) {
    throw new Error("YC alias ledger must have an integer version.");
  }
  if (!Array.isArray(aliasLedger.aliases)) {
    throw new Error("YC alias ledger must contain an aliases array.");
  }
  if (aliasLedger.founderTransitions !== undefined && !Array.isArray(aliasLedger.founderTransitions)) {
    throw new Error("YC alias ledger founderTransitions must be an array when present.");
  }

  const exactTransitions = new Set();
  const stateTargets = new Map();
  const slugOwners = new Map();
  const stateGraph = new Map();
  const slugGraph = new Map();

  for (const [index, alias] of aliasLedger.aliases.entries()) {
    const label = `YC alias ledger entry ${index}`;
    const companyId = requiredString(alias?.companyId, `${label} companyId`);
    const fromSlug = requiredString(alias?.fromSlug, `${label} fromSlug`);
    const fromName = requiredString(alias?.fromName, `${label} fromName`);
    const toSlug = requiredString(alias?.toSlug, `${label} toSlug`);
    const toName = requiredString(alias?.toName, `${label} toName`);
    if (fromSlug === toSlug && fromName === toName) {
      throw new Error(`${label} is an identity transition.`);
    }
    validateAccountMap(alias.companyAccounts, `${label} companyAccounts`);
    if (!Array.isArray(alias.founders)) throw new Error(`${label} founders must be an array.`);
    const founderIds = new Set();
    for (const [founderIndex, founder] of alias.founders.entries()) {
      const founderLabel = `${label} founder ${founderIndex}`;
      const founderId = requiredString(founder?.founderId, `${founderLabel} founderId`);
      requiredString(founder?.name, `${founderLabel} name`);
      if (founder.toName !== undefined) requiredString(founder.toName, `${founderLabel} toName`);
      validateAccountMap(founder.accounts, `${founderLabel} accounts`);
      if (founderIds.has(founderId)) throw new Error(`${label} has duplicate founder ${founderId}.`);
      founderIds.add(founderId);
    }

    const transitionKey = [companyId, fromSlug, fromName, toSlug, toName].join("\u0000");
    if (exactTransitions.has(transitionKey)) {
      throw new Error(`Duplicate YC alias transition ${fromSlug}/${fromName} -> ${toSlug}/${toName}.`);
    }
    exactTransitions.add(transitionKey);

    const fromState = stateKey(companyId, fromSlug, fromName);
    const toState = stateKey(companyId, toSlug, toName);
    const existingTarget = stateTargets.get(fromState);
    if (existingTarget && existingTarget !== toState) {
      throw new Error(`Conflicting YC alias transitions from ${fromSlug}/${fromName}.`);
    }
    stateTargets.set(fromState, toState);
    stateGraph.set(fromState, toState);

    for (const slug of [fromSlug, toSlug]) {
      const owner = slugOwners.get(slug);
      if (owner && owner !== companyId) {
        throw new Error(`YC alias slug ${slug} is assigned to immutable IDs ${owner} and ${companyId}.`);
      }
      slugOwners.set(slug, companyId);
    }
    if (fromSlug !== toSlug) {
      const existingSlugTarget = slugGraph.get(fromSlug);
      if (existingSlugTarget && existingSlugTarget !== toSlug) {
        throw new Error(`Conflicting YC alias slug transitions from ${fromSlug}.`);
      }
      slugGraph.set(fromSlug, toSlug);
    }
  }

  const founderTransitionKeys = new Set();
  for (const [index, transition] of (aliasLedger.founderTransitions ?? []).entries()) {
    const label = `YC founder transition ${index}`;
    requiredString(transition?.companyId, `${label} companyId`);
    requiredString(transition?.companySlug, `${label} companySlug`);
    requiredString(transition?.companyName, `${label} companyName`);
    requiredString(transition?.founderId, `${label} founderId`);
    if (!["added", "removed", "renamed"].includes(transition?.change)) {
      throw new Error(`${label} change must be added, removed, or renamed.`);
    }
    const fromName = transition.fromName === null
      ? null
      : requiredString(transition.fromName, `${label} fromName`);
    const toName = transition.toName === null
      ? null
      : requiredString(transition.toName, `${label} toName`);
    if (
      (transition.change === "added" && (fromName !== null || toName === null)) ||
      (transition.change === "removed" && (fromName === null || toName !== null)) ||
      (transition.change === "renamed" && (fromName === null || toName === null || fromName === toName))
    ) {
      throw new Error(`${label} names do not match its ${transition.change} change.`);
    }
    validateAccountMap(transition.accounts, `${label} accounts`);
    const key = founderTransitionKey(transition);
    if (founderTransitionKeys.has(key)) {
      throw new Error(`${label} duplicates an existing immutable founder transition.`);
    }
    founderTransitionKeys.add(key);
  }

  assertAcyclic(stateGraph, "YC alias identity");
  assertAcyclic(slugGraph, "YC alias slug");

  if (currentCompanies) {
    const companies = Array.isArray(currentCompanies)
      ? validateCatalog({ companies: currentCompanies }, "current YC catalog")
      : validateCatalog(currentCompanies, "current YC catalog");
    const currentById = new Map(companies.map((company) => [company.id, company]));
    const currentSlugOwners = new Map(companies.map((company) => [company.slug, company.id]));

    for (const [slug, companyId] of slugOwners) {
      const currentOwner = currentSlugOwners.get(slug);
      if (currentOwner && currentOwner !== companyId) {
        throw new Error(
          `Historical YC alias slug ${slug} for ${companyId} is now live under immutable ID ${currentOwner}.`
        );
      }
    }

    for (const alias of aliasLedger.aliases) {
      const current = currentById.get(String(alias.companyId));
      if (!current) continue;
      const terminal = terminalState(alias, stateGraph);
      if (terminal.slug !== current.slug || terminal.name !== current.name) {
        throw new Error(
          `YC alias chain for immutable ID ${alias.companyId} ends at ` +
            `${terminal.slug}/${terminal.name}, not current ${current.slug}/${current.name}.`
        );
      }
    }
  }
  return aliasLedger;
}

function validateCatalog(catalog, label) {
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.companies)) {
    throw new Error(`${label} must contain a companies array.`);
  }
  const ids = new Set();
  const slugs = new Set();
  const companies = catalog.companies.map((company, index) => {
    const companyLabel = `${label} company ${index}`;
    const id = requiredString(company?.id, `${companyLabel} id`);
    const slug = requiredString(company?.slug, `${companyLabel} slug`);
    const name = requiredString(company?.name, `${companyLabel} name`);
    if (ids.has(id)) throw new Error(`${label} has duplicate immutable company ID ${id}.`);
    if (slugs.has(slug)) throw new Error(`${label} has duplicate company slug ${slug}.`);
    ids.add(id);
    slugs.add(slug);
    const founders = Array.isArray(company.founders) ? company.founders : [];
    const founderIds = new Set();
    const normalizedFounders = founders.map((founder, founderIndex) => {
      const founderId = requiredString(founder?.id, `${companyLabel} founder ${founderIndex} id`);
      if (founderIds.has(founderId)) {
        throw new Error(`${companyLabel} has duplicate immutable founder ID ${founderId}.`);
      }
      founderIds.add(founderId);
      return {
        ...founder,
        id: founderId,
        name: requiredString(founder?.name, `${companyLabel} founder ${founderIndex} name`)
      };
    });
    return { ...company, id, slug, name, founders: normalizedFounders };
  });
  return companies;
}

function validateAccountMap(accounts, label) {
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) {
    throw new Error(`${label} must be an object.`);
  }
  for (const [platform, urls] of Object.entries(accounts)) {
    if (!PLATFORM_KEYS.includes(platform)) throw new Error(`${label} has unsupported platform ${platform}.`);
    if (!Array.isArray(urls) || urls.some((url) => typeof url !== "string" || !url.trim())) {
      throw new Error(`${label}.${platform} must be an array of non-empty URLs.`);
    }
    if (new Set(urls).size !== urls.length) throw new Error(`${label}.${platform} has duplicate URLs.`);
  }
}

function normalizeAccounts(socialLinks) {
  if (!socialLinks || typeof socialLinks !== "object") return {};
  const entries = [];
  for (const platform of PLATFORM_KEYS) {
    const raw = socialLinks[platform];
    const values = (Array.isArray(raw) ? raw : [raw])
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length > 0) entries.push([platform, [...new Set(values)]]);
  }
  return Object.fromEntries(entries);
}

function deriveFounderTransitions(formerCompany, currentCompany) {
  const formerById = new Map(formerCompany.founders.map((founder) => [founder.id, founder]));
  const currentById = new Map(currentCompany.founders.map((founder) => [founder.id, founder]));
  const shared = {
    companyId: currentCompany.id,
    companySlug: currentCompany.slug,
    companyName: currentCompany.name
  };
  return [
    ...currentCompany.founders
      .filter((founder) => !formerById.has(founder.id))
      .map((founder) => ({
        ...shared,
        founderId: founder.id,
        change: "added",
        fromName: null,
        toName: founder.name,
        accounts: normalizeAccounts(founder.socialLinks)
      })),
    ...formerCompany.founders
      .filter((founder) => !currentById.has(founder.id))
      .map((founder) => ({
        ...shared,
        founderId: founder.id,
        change: "removed",
        fromName: founder.name,
        toName: null,
        accounts: normalizeAccounts(founder.socialLinks)
      })),
    ...currentCompany.founders
      .filter((founder) => {
        const former = formerById.get(founder.id);
        return former && former.name !== founder.name;
      })
      .map((founder) => {
        const former = formerById.get(founder.id);
        return {
          ...shared,
          founderId: founder.id,
          change: "renamed",
          fromName: former.name,
          toName: founder.name,
          accounts: normalizeAccounts(former.socialLinks)
        };
      })
  ];
}

function hasFounderTransition(transitions, candidate) {
  const key = founderTransitionKey(candidate);
  return transitions.some((transition) => founderTransitionKey(transition) === key);
}

function founderTransitionKey(transition) {
  return [
    transition.companyId,
    transition.founderId,
    transition.change,
    transition.fromName ?? "",
    transition.toName ?? ""
  ].join("\u0000");
}

function terminalState(alias, graph) {
  let key = stateKey(String(alias.companyId), alias.fromSlug, alias.fromName);
  while (graph.has(key)) key = graph.get(key);
  const [, slug, name] = key.split("\u0000");
  return { slug, name };
}

function assertAcyclic(graph, label) {
  for (const start of graph.keys()) {
    const seen = new Set();
    let current = start;
    while (graph.has(current)) {
      if (seen.has(current)) throw new Error(`${label} ledger contains a cycle.`);
      seen.add(current);
      current = graph.get(current);
    }
  }
}

function stateKey(companyId, slug, name) {
  return `${companyId}\u0000${slug}\u0000${name}`;
}

function requiredString(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} must be a non-empty string.`);
  return normalized;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
