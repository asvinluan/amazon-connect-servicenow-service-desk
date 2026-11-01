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
  /**
   * Contact Lens rule names allowed to open or update a ticket. Empty means the
   * Contact Lens route is off: events are ignored.
   */
  lensRules: string[];
  /**
   * The subset of lensRules that may OPEN an incident when the call has no ticket.
   * The others only add a note to a ticket that already exists. Keep this to ONE
   * rule: two rules matching the same call arrive at the same instant, and each
   * would find no ticket and open its own.
   */
  lensOpenRules: string[];
}

function seconds(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function names(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
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
    lensRules: names(env.LENS_TICKET_RULES),
    lensOpenRules: names(env.LENS_OPEN_RULES),
  };
}
