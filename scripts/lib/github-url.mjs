const GITHUB_HOST = "github.com";
const GITHUB_PATH_PART = /^[A-Za-z0-9_.-]+$/;

export function parseGithubTargetUrl(rawUrl) {
  try {
    const value = String(rawUrl ?? "").trim();
    if (!value) return null;
    const parsed = new URL(value.replace(/^http:\/\//i, "https://"));
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== GITHUB_HOST) return null;

    const parts = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    const ownerIndex = parts[0]?.toLowerCase() === "orgs" ? 1 : 0;
    const owner = parts[ownerIndex]?.trim() ?? "";
    const repo = (parts[ownerIndex + 1]?.trim() ?? "").replace(/\.git$/i, "");
    if (!owner || !GITHUB_PATH_PART.test(owner)) return null;
    if (repo && !GITHUB_PATH_PART.test(repo)) return null;

    return {
      login: owner,
      repo: repo || null
    };
  } catch {
    return null;
  }
}

export function canonicalGithubTargetUrl(rawUrl) {
  const target = parseGithubTargetUrl(rawUrl);
  if (!target) return null;
  return `https://${GITHUB_HOST}/${target.login}${target.repo ? `/${target.repo}` : ""}`;
}

export function sameGithubTargetUrl(left, right) {
  const leftCanonical = canonicalGithubTargetUrl(left);
  const rightCanonical = canonicalGithubTargetUrl(right);
  return Boolean(
    leftCanonical &&
    rightCanonical &&
    leftCanonical.toLowerCase() === rightCanonical.toLowerCase()
  );
}
