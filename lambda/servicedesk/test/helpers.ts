// Test helpers: a fake ServiceNow, fake secrets, event builders and a way to read
// what the function logged. Nothing here touches AWS or the internet.
import { vi } from "vitest";

import { resetForTests } from "../src/servicenow";

export const INSTANCE = "https://dev12345.service-now.com";
export const USERNAME = "svc_connect_lab";
export const PASSWORD = "S3cr3t-Pass!word-for-tests";
export const CLIENT_ID = "client-id-for-tests-0001";
export const CLIENT_SECRET = "Cl13nt-S3cr3t-for-tests-0002";

export const SECRET_BASIC = JSON.stringify({
  instance_url: INSTANCE,
  auth: "basic",
  username: USERNAME,
  password: PASSWORD,
});
export const SECRET_OAUTH = JSON.stringify({
  instance_url: INSTANCE,
  auth: "oauth",
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
});
export const BASIC = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;

export const CONTACT_ID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
export const CALLER = "+61355500101"; // 03 5550 0101, the range reserved for TV and film
export const OTHER_CALLER = "+61355500102";
export const USER_SYS_ID = "a".repeat(32);
export const OTHER_SYS_ID = "b".repeat(32);
/** The customer number on the test user. Its last four digits are the "PIN". */
export const CUSTOMER_REF = "CUST-48201357";
export const RIGHT_DIGITS = "1357";
export const WRONG_DIGITS = "1358";

export interface FakeUser {
  sys_id: string;
  name: string;
  phone?: string;
  mobile_phone?: string;
  employee_number?: string;
}

export interface FakeTicket {
  sys_id: string;
  number: string;
  state: string;
  request_state?: string;
  owner: string;
  correlation_id?: string;
  work_notes: string[];
}

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  rawUrl: string;
  headers: Record<string, string>;
  /** Parsed JSON body for Table API calls. */
  body: Record<string, string> | undefined;
  /** The body exactly as sent (a form string for the token call). */
  rawBody: string | undefined;
}

type Override = (call: Call) => Response | Promise<Response> | undefined;

/** A fake ServiceNow Table API plus OAuth token endpoint. Answers the way the real ones do for these calls. */
export class FakeServiceNow {
  users: FakeUser[] = [];
  incidents: FakeTicket[] = [];
  requests: FakeTicket[] = [];
  calls: Call[] = [];
  override: Override | undefined;
  private counter = 10_000;

  // ---- OAuth behaviour ----
  tokensIssued = 0;
  /** Tokens the fake currently accepts. Emptying it simulates revocation. */
  validTokens = new Set<string>();
  tokenExpiresIn: number | undefined = 1800;
  requireBearer = false;

  fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = init?.body === undefined ? undefined : String(init.body);
    const isToken = url.pathname === "/oauth_token.do";
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      rawUrl: String(input),
      headers,
      body: rawBody && !isToken ? (JSON.parse(rawBody) as Record<string, string>) : undefined,
      rawBody,
    };
    this.calls.push(call);

    const forced = this.override?.(call);
    if (forced) return forced;

    if (isToken) return this.token(call);

    if (this.requireBearer) {
      const given = headers.Authorization ?? "";
      const ok = given.startsWith("Bearer ") && this.validTokens.has(given.slice(7));
      if (!ok) return this.json({ error: "unauthorised" }, 401);
    }
    return this.route(call);
  });

  private json(result: unknown, status = 200): Response {
    return new Response(JSON.stringify({ result }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private token(call: Call): Response {
    const form = new URLSearchParams(call.rawBody ?? "");
    if (
      form.get("grant_type") !== "client_credentials" ||
      form.get("client_id") !== CLIENT_ID ||
      form.get("client_secret") !== CLIENT_SECRET
    ) {
      return new Response(JSON.stringify({ error: "access_denied" }), { status: 401 });
    }
    this.tokensIssued += 1;
    const access = `token-${this.tokensIssued}`;
    this.validTokens.add(access);
    const out: Record<string, unknown> = { access_token: access, token_type: "Bearer" };
    if (this.tokenExpiresIn !== undefined) out.expires_in = this.tokenExpiresIn;
    return new Response(JSON.stringify(out), { status: 200 });
  }

  private route(call: Call): Response {
    const q = call.query.sysparm_query ?? "";

    if (call.method === "GET" && call.path === "/api/now/table/sys_user") {
      const wanted = [...q.matchAll(/(?:mobile_phone|phone)=([^^]+)/g)].map((m) => m[1]);
      const hit = this.users.find(
        (u) => wanted.includes(u.phone ?? "\u0000") || wanted.includes(u.mobile_phone ?? "\u0000"),
      );
      return this.json(
        hit ? [{ sys_id: hit.sys_id, name: hit.name, employee_number: hit.employee_number ?? "" }] : [],
      );
    }

    for (const [table, list, ownerField] of [
      ["incident", this.incidents, "caller_id"],
      ["sc_request", this.requests, "requested_for"],
    ] as const) {
      const base = `/api/now/table/${table}`;
      const row = (t: FakeTicket): Record<string, string> =>
        table === "incident"
          ? { sys_id: t.sys_id, number: t.number, state: t.state, caller_id: t.owner }
          : {
              sys_id: t.sys_id,
              number: t.number,
              state: t.state,
              request_state: t.request_state ?? "",
              requested_for: t.owner,
            };

      if (call.method === "GET" && call.path === base) {
        const byContact = /correlation_id=([^^]+)/.exec(q)?.[1];
        const byNumber = /number=([^^]+)/.exec(q)?.[1];
        const hit = list.find(
          (t) => (byContact && t.correlation_id === byContact) || (byNumber && t.number === byNumber),
        );
        return this.json(hit ? [row(hit)] : []);
      }

      if (call.method === "POST" && call.path === base) {
        this.counter += 1;
        const t: FakeTicket = {
          sys_id: String(this.counter).padStart(32, "0"),
          number: `${table === "incident" ? "INC" : "REQ"}00${this.counter}`,
          state: "1",
          request_state: table === "sc_request" ? "requested" : undefined,
          owner: call.body?.[ownerField] ?? "",
          correlation_id: call.body?.correlation_id,
          work_notes: call.body?.work_notes ? [call.body.work_notes] : [],
        };
        list.push(t);
        return this.json(row(t), 201);
      }

      const patch = new RegExp(`^${base}/([0-9a-f]{32})$`, "i").exec(call.path);
      if (call.method === "PATCH" && patch) {
        const hit = list.find((t) => t.sys_id === patch[1]);
        if (!hit) return this.json({}, 404);
        if (call.body?.work_notes) hit.work_notes.push(call.body.work_notes);
        return this.json({ sys_id: hit.sys_id });
      }
    }

    return this.json({}, 404);
  }

  callsTo(method: string, path: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  /** The standard test user: known phone, a customer number, a name. */
  addUser(overrides: Partial<FakeUser> = {}): FakeUser {
    const user: FakeUser = {
      sys_id: USER_SYS_ID,
      name: "Test Caller Lab",
      mobile_phone: CALLER,
      employee_number: CUSTOMER_REF,
      ...overrides,
    };
    this.users.push(user);
    return user;
  }
}

/** Fresh fake, installed as the global fetch, with a working secret. */
export function install(secret: string | (() => Promise<string | undefined>) = SECRET_BASIC) {
  const fake = new FakeServiceNow();
  vi.stubGlobal("fetch", fake.fetch);
  const read = vi.fn(async () => (typeof secret === "function" ? secret() : secret));
  resetForTests(read);
  process.env.SERVICENOW_SECRET_ID = "lab/servicenow";
  delete process.env.SERVICENOW_TOTAL_BUDGET_SEC;
  delete process.env.SERVICENOW_CALL_TIMEOUT_SEC;
  return { fake, read };
}

export function flowEvent(
  parameters: Record<string, string> = {},
  opts: { contactId?: string | null; address?: string | null } = {},
) {
  const contactId = opts.contactId === undefined ? CONTACT_ID : opts.contactId;
  const address = opts.address === undefined ? CALLER : opts.address;
  return {
    Details: {
      Parameters: parameters,
      ContactData: {
        ...(contactId ? { ContactId: contactId } : {}),
        ...(address ? { CustomerEndpoint: { Address: address } } : {}),
      },
    },
  };
}

export function disconnectEvent(overrides: Record<string, unknown> = {}) {
  return {
    "detail-type": "Amazon Connect Contact Event",
    source: "aws.connect",
    detail: {
      eventType: "DISCONNECTED",
      channel: "VOICE",
      contactId: CONTACT_ID,
      initiationTimestamp: "2026-10-28T01:00:00.000Z",
      disconnectTimestamp: "2026-10-28T01:02:05.000Z",
      agentInfo: { connectedToAgentTimestamp: "2026-10-28T01:00:20.000Z" },
      ...overrides,
    },
  };
}

/** Everything the function wrote to the console (logs and metrics) in one string. */
export function captureConsole(): { text: () => string; lines: () => string[] } {
  const lines: string[] = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  return { text: () => lines.join("\n"), lines: () => [...lines] };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

/** What a Contact Lens rule publishes to EventBridge when it matches (post-call by default). */
export function lensEvent(
  overrides: Record<string, unknown> = {},
  detailType = "conversational analytics Post Call Rules Matched",
) {
  return {
    version: "0",
    id: "11111111-2222-3333-4444-555555555555",
    source: "aws.connect",
    "detail-type": detailType,
    detail: {
      version: "1.0",
      ruleName: "Negative-Sentiment",
      actionName: "lens-lab-negative-sentiment",
      instanceArn: "arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-0000-0000-0000-000000000000",
      contactArn: `arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-0000-0000-0000-000000000000/contact/${CONTACT_ID}`,
      ...overrides,
    },
  };
}
