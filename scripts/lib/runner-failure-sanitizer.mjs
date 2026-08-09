const KNOWN_SECRET = /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|sbp_[A-Za-z0-9]{20,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/gi;
const SENSITIVE_QUERY_VALUE = /([?&](?:(?:access|auth|id|refresh|session)[_-]?token|api[_-]?key|auth|authorization|bearer|client[_-]?secret|cookie|credential|password|secret|session(?:id)?|sig(?:nature)?|token|x-api-key)=)[^&#\s]*/gi;
const SENSITIVE_FIELD_VALUE = /((?:["']?)(?:(?:access|auth|id|refresh|session)[_-]?token|api[_-]?key|bearer|client[_-]?secret|cookie|credential|password|passwd|private[_-]?key|secret|session(?:id)?|sig(?:nature)?|token|x-api-key)(?:["']?)(?:\s*[:=]\s*))(?!\[redacted\])(?:(?:"[^"\r\n]*")|(?:'[^'\r\n]*')|(?:[^\s,;&}\]\r\n]+))/gi;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]+@/gi;
const HIGH_CONFIDENCE_SECRET = /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|sbp_[A-Za-z0-9]{20,}|\b(?:Basic|Bearer)\s+(?!\[redacted\])[^\s,;]+|\b[a-z][a-z0-9+.-]*:\/\/(?!\[redacted\]@)[^/\s?#]+@|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;

function replaceConfiguredSecrets(value, secrets) {
  let message = value;
  for (const secret of secrets) {
    const normalized = String(secret ?? "");
    if (normalized.length >= 8) message = message.split(normalized).join("[redacted]");
  }
  return message;
}

function decodeForRedaction(value) {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
        try {
          return decodeURIComponent(encoded);
        } catch {
          return encoded;
        }
      });
    }
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function redactStructuredSecrets(value) {
  return value
    .replace(URL_USERINFO, "$1[redacted]@")
    .replace(/\b((?:set-cookie|cookie)\s*:\s*)(?!\[redacted\])[^\r\n]*/gi, "$1[redacted]")
    .replace(
      /\b((?:proxy-)?authorization["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:(?:basic|bearer|token)\s+)?[^\s,;]+)/gi,
      "$1[redacted]"
    )
    .replace(/\b(Basic)\s+[A-Za-z0-9+/_-]{4,}={0,2}/gi, "$1 [redacted]")
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(SENSITIVE_QUERY_VALUE, "$1[redacted]")
    .replace(SENSITIVE_FIELD_VALUE, "$1[redacted]")
    .replace(/\b(?:JSESSIONID|li_at|sessionid|connect\.sid|auth_token)\s*=\s*[^;\s]+/gi, "[redacted-cookie]")
    .replace(KNOWN_SECRET, "[redacted]");
}

export function sanitizeRunnerFailureMessage(value, { secrets = [], maxLength = 2048 } = {}) {
  let message = String(value ?? "");
  message = replaceConfiguredSecrets(message, secrets);
  message = redactStructuredSecrets(message);
  message = decodeForRedaction(message);
  message = replaceConfiguredSecrets(message, secrets);
  message = redactStructuredSecrets(message)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  message = replaceConfiguredSecrets(message, secrets);
  message = redactStructuredSecrets(message).slice(0, Math.max(0, Number(maxLength) || 0));
  return HIGH_CONFIDENCE_SECRET.test(message) ? "redacted_failure_message" : message;
}
