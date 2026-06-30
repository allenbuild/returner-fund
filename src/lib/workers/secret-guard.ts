const SECRET_KEY_PATTERN =
  /(authorization|bearer|cookie|cookies|password|secret|session|token|api[_-]?key|service[_-]?role)/i;

const SECRET_VALUE_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /(?:^|\s)Bearer\s+[A-Za-z0-9._-]{12,}/i,
  /(?:^|;\s*)[A-Za-z0-9_-]{3,}=[A-Za-z0-9%._-]{16,}(?:;|$)/
];

export interface SecretLikeFinding {
  path: string;
  reason: "secret-key" | "secret-value";
}

export function findSecretLikeFields(value: unknown, path = "$"): SecretLikeFinding[] {
  const findings: SecretLikeFinding[] = [];
  visit(value, path, findings);
  return findings;
}

export function hasSecretLikeContent(content: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(content));
}

function visit(value: unknown, path: string, findings: SecretLikeFinding[]): void {
  if (typeof value === "string") {
    if (value.trim() && SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      findings.push({ path, reason: "secret-value" });
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`, findings));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key) && hasNonEmptyValue(child)) {
      findings.push({ path: childPath, reason: "secret-key" });
    }
    visit(child, childPath, findings);
  }
}

function hasNonEmptyValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return value !== undefined && value !== null;
}
