export const V5_RUNTIME_ENVIRONMENT = Object.freeze({
  nodeVersion: "24.14.0",
  timezone: "UTC",
  locale: "en-US"
});

export function prepareAndAssertV5Runtime() {
  if (process.env.TZ === undefined) process.env.TZ = V5_RUNTIME_ENVIRONMENT.timezone;
  const actual = Object.freeze({
    nodeVersion: process.versions.node,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale
  });
  assertV5Runtime(actual);
  return actual;
}

export function assertV5Runtime(actual) {
  for (const key of Object.keys(V5_RUNTIME_ENVIRONMENT)) {
    if (actual[key] !== V5_RUNTIME_ENVIRONMENT[key]) {
      throw new Error(
        `V5 runtime ${key} must be ${V5_RUNTIME_ENVIRONMENT[key]}; received ${String(actual[key])}.`
      );
    }
  }
}
