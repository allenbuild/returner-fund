const TIMELINE_COVERAGE_TABLE = /(?:public\.)?timeline_source_coverage/i;
const MISSING_RELATION_DIAGNOSTIC =
  /(?:could not find (?:the )?table[^\n]*schema cache|relation [^\n]* does not exist|table [^\n]*(?:not found|does not exist))/i;

export function isTimelineCoverageMigrationUnavailable(error) {
  if (!error) return false;
  const code = String(error.code ?? "").trim().toUpperCase();
  const diagnostic = [error.message, error.details, error.hint]
    .filter(Boolean)
    .map(String)
    .join("\n");
  if (!TIMELINE_COVERAGE_TABLE.test(diagnostic)) return false;
  return code === "42P01"
    || code === "PGRST205"
    || MISSING_RELATION_DIAGNOSTIC.test(diagnostic);
}
