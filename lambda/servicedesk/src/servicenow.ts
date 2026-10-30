// The ServiceNow side: read the credentials, get a token if needed, make Table
// API calls.
//
// Three rules shape everything in this file:
//
//  1. Amazon Connect abandons a flow Lambda at 8 SECONDS. Every outbound call
//     here is handed whatever is left of a total budget (never more than a few
//     seconds), and the budget is checked BETWEEN calls, because a socket
//     timeout applies per operation, not to the whole invocation. Fetching an
//     OAuth token is a call like any other and spends the same budget.
//
//  2. Secrets never leave AWS or the log. They live in Secrets Manager, are read
//     once per warm container, are only ever sent to a host ending in
//     ".service-now.com", and never appear in a log line, an error message or a
//     response. The same goes for the OAuth access token. Only HTTP status
//     codes and short reason codes are logged.
//
//  3. Two ways to sign in, chosen by the secret:
//       "auth": "oauth"  OAuth 2.0 client credentials. A short-lived token is
//                        fetched, cached, and refreshed when it expires or when
//                        ServiceNow answers 401. No user password is stored.
//       "auth": "basic"  A user name and password. Simple, and fine for a
//                        developer instance, but the password is long-lived.
//     OAuth is the design to copy. Basic is the fallback for an instance where
//     the client-credentials grant is not switched on.
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import type { Config } from "./config";
import { PHONE_RE } from "./phone";
import { logger } from "./telemetry";

// ---------------------------------------------------------------------------
// Errors and the time budget
// ---------------------------------------------------------------------------

/**
 * Internal: stop and return a safe answer instead of failing the call.
 *
 * "degraded" means ServiceNow (or the network) is struggling and trying again
 * later may work. "error" means something is wrong that a retry will not fix,
 * such as a bad password.
 */
export class Fallback extends Error {
  constructor(
    public readonly reason: string,
    public readonly status: "degraded" | "error" = "error",
  ) {
    super(reason);
    this.name = "Fallback";
  }

  get retryable(): boolean {
    return this.status === "degraded";
  }
}

export class Deadline {
  private constructor(
    private readonly endsAt: number,
    private readonly perCallMs: number,
  ) {}

  static start(config: Config): Deadline {
    return new Deadline(performance.now() + config.totalBudgetMs, config.callTimeoutMs);
  }

  /** Milliseconds the next call may use. Refuses to start if the budget is spent. */
  next(): number {
    const left = this.endsAt - performance.now();
    if (left <= 50) throw new Fallback("budget_exhausted", "degraded");
    return Math.min(this.perCallMs, left);
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function isTransient(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

// ---------------------------------------------------------------------------
// Credentials (Secrets Manager)
// ---------------------------------------------------------------------------

export type Auth =
  | { kind: "basic"; header: string }
  | { kind: "oauth"; clientId: string; clientSecret: string };

export interface Credentials {
  /** https://<instance>.service-now.com, no trailing slash. */
  baseUrl: string;
  auth: Auth;
}

// Module scope, so warm invocations reuse the connection and the caches below.
// One attempt only: a retry would spend budget the ServiceNow calls need.
const secretsClient = new SecretsManagerClient({ maxAttempts: 1 });
let cachedCredentials: Credentials | null = null;
let cachedToken: { value: string; expiresAt: number } | null = null;
// A token request already under way. Two lookups that start side by side must
// share one token request, not each make their own.
let tokenInFlight: Promise<string> | null = null;

/** Reads the secret text. A separate function so a test can swap it out. */
export type SecretFetcher = (secretId: string, timeoutMs: number) => Promise<string | undefined>;

const awsSecretFetcher: SecretFetcher = async (secretId, timeoutMs) => {
  const out = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }), {
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  return out.SecretString;
};

let fetchSecret: SecretFetcher = awsSecretFetcher;

/** Tests only: forget the cached credentials and token, and optionally replace the secret reader. */
export function resetForTests(fetcher?: SecretFetcher): void {
  cachedCredentials = null;
  cachedToken = null;
  tokenInFlight = null;
  fetchSecret = fetcher ?? awsSecretFetcher;
}

const ALLOWED_HOST_SUFFIX = ".service-now.com";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export async function loadCredentials(secretId: string, deadline: Deadline): Promise<Credentials> {
  if (cachedCredentials) return cachedCredentials;

  const ms = deadline.next(); // refuse to start if the budget is already spent
  let raw: string | undefined;
  try {
    raw = await fetchSecret(secretId, ms);
  } catch (err) {
    logger.error("secret read failed", { error: errorName(err) });
    throw new Fallback("secret_unreachable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    // The usual cause is a missing pair of quotes in the secret text.
    logger.error("secret is not valid JSON");
    throw new Fallback("secret_invalid_json");
  }

  const secret = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const instanceUrl = secret.instance_url;

  // "auth" says which sign-in to use. If it is missing, work it out from the keys.
  const mode =
    secret.auth === "oauth" || secret.auth === "basic"
      ? secret.auth
      : nonEmpty(secret.client_id)
        ? "oauth"
        : "basic";

  let auth: Auth;
  if (mode === "oauth") {
    if (!nonEmpty(instanceUrl) || !nonEmpty(secret.client_id) || !nonEmpty(secret.client_secret)) {
      logger.error("secret is missing one of instance_url, client_id, client_secret");
      throw new Fallback("secret_missing_keys");
    }
    auth = { kind: "oauth", clientId: secret.client_id, clientSecret: secret.client_secret };
  } else {
    if (!nonEmpty(instanceUrl) || !nonEmpty(secret.username) || !nonEmpty(secret.password)) {
      logger.error("secret is missing one of instance_url, username, password");
      throw new Fallback("secret_missing_keys");
    }
    auth = {
      kind: "basic",
      header: `Basic ${Buffer.from(`${secret.username}:${secret.password}`, "utf8").toString("base64")}`,
    };
  }

  let url: URL;
  try {
    url = new URL(instanceUrl);
  } catch {
    logger.error("instance_url is not a valid address");
    throw new Fallback("instance_url_not_servicenow");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(ALLOWED_HOST_SUFFIX) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    // Never send a secret to a host that is not ServiceNow.
    logger.error("instance_url is not an https ServiceNow address");
    throw new Fallback("instance_url_not_servicenow");
  }

  cachedCredentials = { baseUrl: `https://${url.hostname}`, auth };
  return cachedCredentials;
}

// ---------------------------------------------------------------------------
// One HTTP exchange
// ---------------------------------------------------------------------------

interface Exchange {
  status: number;
  text: string;
}

/** Send one request. Network trouble becomes a "degraded" Fallback. */
async function send(
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Exchange> {
  try {
    const res = await fetch(url, {
      ...init,
      // A redirect would carry the request (and its secret) somewhere else.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text(); // inside the try, so the timeout covers the body too
    return { status: res.status, text };
  } catch (err) {
    const timedOut = isTimeout(err);
    logger.error("servicenow request failed", { what: label, error: timedOut ? "timeout" : errorName(err) });
    throw new Fallback(timedOut ? "timeout" : "network", "degraded");
  }
}

// ---------------------------------------------------------------------------
// OAuth 2.0 client credentials
// ---------------------------------------------------------------------------

const TOKEN_SAFETY_MARGIN_MS = 60_000;
const TOKEN_DEFAULT_LIFETIME_S = 1800;

async function fetchToken(
  creds: Credentials,
  auth: Extract<Auth, { kind: "oauth" }>,
  deadline: Deadline,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
  }).toString();

  const res = await send(
    "oauth token",
    `${creds.baseUrl}/oauth_token.do`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    },
    deadline.next(),
  );

  if (res.status < 200 || res.status > 299) {
    // Status only. The body can say which part of the client is wrong.
    logger.error("servicenow refused the token request", { status: res.status });
    throw new Fallback(`oauth_http_${res.status}`, isTransient(res.status) ? "degraded" : "error");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    logger.error("token endpoint answered with something that is not JSON");
    throw new Fallback("oauth_bad_response", "degraded");
  }
  const obj = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const token = obj.access_token;
  if (!nonEmpty(token)) {
    logger.error("token response has no access_token");
    throw new Fallback("oauth_bad_response");
  }
  const lifetime =
    typeof obj.expires_in === "number" && obj.expires_in > 0 ? obj.expires_in : TOKEN_DEFAULT_LIFETIME_S;
  cachedToken = {
    value: token,
    expiresAt: Date.now() + Math.max(0, lifetime * 1000 - TOKEN_SAFETY_MARGIN_MS),
  };
  return token;
}

/** The Authorization header value for the next call. */
async function authorization(creds: Credentials, deadline: Deadline): Promise<string> {
  if (creds.auth.kind === "basic") return creds.auth.header;
  if (cachedToken && cachedToken.expiresAt > Date.now()) return `Bearer ${cachedToken.value}`;

  const auth = creds.auth;
  tokenInFlight ??= fetchToken(creds, auth, deadline).finally(() => {
    tokenInFlight = null;
  });
  return `Bearer ${await tokenInFlight}`;
}

// ---------------------------------------------------------------------------
// One Table API call
// ---------------------------------------------------------------------------

type Query = Record<string, string>;

/**
 * Encode a query string. encodeURIComponent turns a space into %20, a plus into
 * %2B and a caret into %5E. That matters: a raw "+" in a query string means
 * "space", so an unencoded +61 number would match nobody, quietly.
 */
function encodeQuery(query: Query): string {
  return Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function call(
  creds: Credentials,
  deadline: Deadline,
  method: "GET" | "POST" | "PATCH",
  path: string,
  query: Query,
  body?: Record<string, unknown>,
): Promise<unknown> {
  let res: Exchange | undefined;

  // At most two goes: with OAuth, a 401 usually means the cached token has
  // expired early or been revoked, so fetch a fresh one and try once more.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers: Record<string, string> = {
      Authorization: await authorization(creds, deadline),
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    res = await send(
      `${method} ${path}`,
      `${creds.baseUrl}${path}?${encodeQuery(query)}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      deadline.next(),
    );

    if (res.status === 401 && creds.auth.kind === "oauth" && attempt === 0) {
      logger.warn("servicenow answered 401, fetching a new token");
      cachedToken = null;
      continue;
    }
    break;
  }

  if (!res) throw new Fallback("network", "degraded"); // unreachable, keeps the types honest

  if (res.status < 200 || res.status > 299) {
    // Log the number only. The body can echo record data.
    logger.error("servicenow rejected the request", { method, path, status: res.status });
    throw new Fallback(`http_${res.status}`, isTransient(res.status) ? "degraded" : "error");
  }

  try {
    return JSON.parse(res.text);
  } catch {
    // A sleeping developer instance answers with an HTML page, not JSON.
    logger.error("servicenow answered with something that is not JSON", { method, path });
    throw new Fallback("bad_response", "degraded");
  }
}

function resultOf(data: unknown): unknown {
  if (typeof data === "object" && data !== null && "result" in data) {
    return (data as { result: unknown }).result;
  }
  throw new Fallback("bad_response");
}

function firstRow(data: unknown): Record<string, unknown> | null {
  const result = resultOf(data);
  if (!Array.isArray(result)) throw new Fallback("bad_response");
  const row: unknown = result[0];
  if (row === undefined) return null;
  if (typeof row !== "object" || row === null) throw new Fallback("bad_response");
  return row as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

const TABLE = "/api/now/table";
const CONTACT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;

export const isContactId = (value: string): boolean => CONTACT_ID_RE.test(value);

export interface FoundUser {
  sysId: string;
  name: string;
  /**
   * The customer number on the record (Employee ID). Used ONLY to verify the
   * caller. It must never be logged, returned or put on the contact.
   */
  customerRef: string;
}

/** The active user whose phone or mobile phone matches one of the variants. */
export async function findUserByPhone(
  creds: Credentials,
  variants: string[],
  deadline: Deadline,
): Promise<FoundUser | null> {
  // Every value is checked as digits with an optional plus before it can reach a
  // query, so nothing caller-supplied can add its own "^" condition.
  if (variants.length === 0 || !variants.every((v) => PHONE_RE.test(v))) {
    throw new Fallback("unusable_number");
  }
  // In an encoded query "^OR" attaches to the term before it, so this reads as
  // active=true AND (mobile = v1 OR phone = v1 OR mobile = v2 OR phone = v2).
  const terms = variants.flatMap((v) => [`mobile_phone=${v}`, `phone=${v}`]);
  const row = firstRow(
    await call(creds, deadline, "GET", `${TABLE}/sys_user`, {
      sysparm_query: `active=true^${terms.join("^OR")}`,
      sysparm_limit: "1",
      sysparm_fields: "sys_id,name,employee_number",
      sysparm_exclude_reference_link: "true",
    }),
  );
  if (!row) return null;
  const sysId = str(row.sys_id);
  if (!SYS_ID_RE.test(sysId)) throw new Fallback("bad_response");
  return { sysId, name: str(row.name), customerRef: str(row.employee_number) };
}

// ---- tickets: incidents and service requests -------------------------------

export type TicketKind = "incident" | "request";

const TABLE_OF: Record<TicketKind, string> = { incident: "incident", request: "sc_request" };
const FIELDS_OF: Record<TicketKind, string> = {
  incident: "sys_id,number,state,caller_id",
  request: "sys_id,number,request_state,state,requested_for",
};
const NUMBER_RE: Record<TicketKind, RegExp> = {
  incident: /^INC\d{7}$/,
  request: /^REQ\d{7}$/,
};
const NUMBER_PREFIX: Record<TicketKind, string> = { incident: "INC", request: "REQ" };

export interface Ticket {
  kind: TicketKind;
  sysId: string;
  number: string;
  state: string;
  /** Requests only: the text request state ("requested", "approved" ...). */
  requestState: string;
  /** sys_id of the person the ticket belongs to (incident caller, request "requested for"). */
  ownerSysId: string;
}

function toTicket(kind: TicketKind, row: Record<string, unknown>): Ticket {
  const sysId = str(row.sys_id);
  const number = str(row.number);
  if (!SYS_ID_RE.test(sysId) || !NUMBER_RE[kind].test(number)) throw new Fallback("bad_response");
  return {
    kind,
    sysId,
    number,
    state: str(row.state),
    requestState: str(row.request_state),
    ownerSysId: str(kind === "incident" ? row.caller_id : row.requested_for),
  };
}

/** The ticket this phone call already created, if any (makes create safe to repeat). */
export async function findTicketByContactId(
  creds: Credentials,
  kind: TicketKind,
  contactId: string,
  deadline: Deadline,
): Promise<Ticket | null> {
  if (!CONTACT_ID_RE.test(contactId)) throw new Fallback("unusable_contact_id");
  const row = firstRow(
    await call(creds, deadline, "GET", `${TABLE}/${TABLE_OF[kind]}`, {
      sysparm_query: `correlation_id=${contactId}`,
      sysparm_limit: "1",
      sysparm_fields: FIELDS_OF[kind],
      sysparm_exclude_reference_link: "true",
    }),
  );
  return row ? toTicket(kind, row) : null;
}

/** Look a ticket up by the seven digits a caller keyed in. */
export async function findTicketByDigits(
  creds: Credentials,
  kind: TicketKind,
  digits: string,
  deadline: Deadline,
): Promise<Ticket | null> {
  if (!/^\d{7}$/.test(digits)) throw new Fallback("invalid_number");
  const row = firstRow(
    await call(creds, deadline, "GET", `${TABLE}/${TABLE_OF[kind]}`, {
      sysparm_query: `number=${NUMBER_PREFIX[kind]}${digits}`,
      sysparm_limit: "1",
      sysparm_fields: FIELDS_OF[kind],
      sysparm_exclude_reference_link: "true",
    }),
  );
  return row ? toTicket(kind, row) : null;
}

export async function createTicket(
  creds: Credentials,
  kind: TicketKind,
  fields: Record<string, string>,
  deadline: Deadline,
): Promise<Ticket> {
  const result = resultOf(
    await call(
      creds,
      deadline,
      "POST",
      `${TABLE}/${TABLE_OF[kind]}`,
      { sysparm_fields: FIELDS_OF[kind], sysparm_exclude_reference_link: "true" },
      fields,
    ),
  );
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Fallback("bad_response");
  }
  return toTicket(kind, result as Record<string, unknown>);
}

/** Add a work note (an internal comment) to a ticket. */
export async function addWorkNote(
  creds: Credentials,
  kind: TicketKind,
  sysId: string,
  note: string,
  deadline: Deadline,
): Promise<void> {
  if (!SYS_ID_RE.test(sysId)) throw new Fallback("bad_response");
  await call(
    creds,
    deadline,
    "PATCH",
    `${TABLE}/${TABLE_OF[kind]}/${sysId}`,
    { sysparm_fields: "sys_id" },
    { work_notes: note },
  );
}
