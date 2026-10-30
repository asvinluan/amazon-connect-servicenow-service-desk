// Settings, read from environment variables at the START OF EACH INVOCATION
// (not at import), so a test can change them and a warm container still sees
// the value Terraform set.

export interface Config {
  /** Name of the Secrets Manager secret holding the ServiceNow sign-in (see servicenow.ts). */
  secretId: string;
  /** Longest any single outbound call may take, in milliseconds. */
  callTimeoutMs: number;
  /** Total time the whole invocation may spend, in milliseconds. */
  totalBudgetMs: number;
}

function seconds(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    secretId: env.SERVICENOW_SECRET_ID ?? "",
    // Amazon Connect abandons a flow Lambda at 8 seconds. Three sequential
    // ServiceNow calls to a developer instance on the other side of the world
    // need more room than the Salesforce lookup, so the budget here is 6 seconds
    // and the Lambda's own timeout (Terraform) is the hard backstop under 8.
    callTimeoutMs: seconds(env.SERVICENOW_CALL_TIMEOUT_SEC, 3) * 1000,
    totalBudgetMs: seconds(env.SERVICENOW_TOTAL_BUDGET_SEC, 6) * 1000,
  };
}
