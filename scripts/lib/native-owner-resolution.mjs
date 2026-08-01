export function preferUniqueSameCompanyFounder(candidates = []) {
  const companies = new Set(candidates.map((candidate) => candidate?.companySlug).filter(Boolean));
  if (companies.size !== 1) return candidates;

  const founders = candidates.filter((candidate) => candidate?.entityType === "founder");
  return founders.length === 1 ? founders : candidates;
}
