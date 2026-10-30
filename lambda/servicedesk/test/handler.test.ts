// Unit tests for the service desk Lambda.
//
// Nothing here touches AWS or ServiceNow. The secret is a fake reader and the
// network is a fake ServiceNow that answers the way the Table API does. Every
// credential and number is obviously fake.
//
// What these tests pin down, because each is easy to break by accident:
//
//   1. Verification is real. A wrong digit, a missing customer number or an
//      unknown caller NEVER reaches the ticket table, and never creates a request.
//   2. Not finding a ticket and not owning it give the identical answer.
//   3. Nothing sensitive reaches a log: no password, token, keyed digits,
//      customer number, full phone number or name.
//   4. Every failure returns a usable answer and never throws, so the caller still
//      reaches an agent.
//   5. A "+" in the phone number is sent as %2B (a raw "+" means "space").
//   6. Create is safe to repeat: the same phone call never makes two tickets.
//   7. Every value returned to Amazon Connect is a string.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "../src/handler";
import {
  CALLER,
  CONTACT_ID,
  CUSTOMER_REF,
  FakeServiceNow,
  OTHER_CALLER,
  OTHER_SYS_ID,
  PASSWORD,
  RIGHT_DIGITS,
  USER_SYS_ID,
  WRONG_DIGITS,
  captureConsole,
  disconnectEvent,
  flowEvent,
  install,
  jsonResponse,
  timeoutError,
} from "./helpers";

let fake: FakeServiceNow;

beforeEach(() => {
  ({ fake } = install());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function allStrings(result: Record<string, unknown>): boolean {
  return Object.values(result).every((v) => typeof v === "string");
}

const TICKET_TABLES = ["/api/now/table/incident", "/api/now/table/sc_request"];
const ticketCalls = () => fake.calls.filter((c) => TICKET_TABLES.some((t) => c.path.startsWith(t)));

function seedTicket(
  kind: "incident" | "request",
  over: Partial<(typeof fake.incidents)[number]> = {},
): (typeof fake.incidents)[number] {
  const t = {
    sys_id: "c".repeat(32),
    number: kind === "incident" ? "INC0010007" : "REQ0010007",
    state: "2",
    request_state: kind === "request" ? "in_process" : undefined,
    owner: USER_SYS_ID,
    work_notes: [] as string[],
    ...over,
  };
  (kind === "incident" ? fake.incidents : fake.requests).push(t);
  return t;
}

// ---------------------------------------------------------------------------
describe("identify", () => {
  it("says a known caller is known, and keeps the name for the agent's screen only", async () => {
    fake.addUser();
    const result = await handler(flowEvent({ action: "identify" }));

    expect(result).toMatchObject({ status: "identified", callerKnown: "true", callerMatch: "Test Caller Lab" });
    // The name has its own field. There is no field the flow would speak.
    expect(Object.keys(result)).not.toContain("callerName");
    expect(allStrings(result)).toBe(true);
  });

  it("says an unrecognised caller is unknown (not an error)", async () => {
    const result = await handler(flowEvent({ action: "identify" }));
    expect(result).toMatchObject({ status: "unknown", reason: "no_match", callerKnown: "false", callerMatch: "" });
  });

  it("does not call ServiceNow at all for a withheld number", async () => {
    const result = await handler(flowEvent({ action: "identify" }, { address: null }));
    expect(result).toMatchObject({ status: "unknown", reason: "withheld_number", callerKnown: "false" });
    expect(fake.calls).toHaveLength(0);
  });

  it("sends the + in the number as %2B", async () => {
    fake.addUser();
    await handler(flowEvent({ action: "identify" }));
    const get = fake.callsTo("GET", "/api/now/table/sys_user")[0];
    expect(get?.rawUrl).toContain("%2B61355500101");
    expect(get?.rawUrl).not.toMatch(/[=^]\+61/);
  });

  it("returns 'unknown' with a reason when ServiceNow is down, and does not throw", async () => {
    fake.override = () => jsonResponse(503, {});
    const result = await handler(flowEvent({ action: "identify" }));
    expect(result).toMatchObject({ status: "degraded", reason: "http_503", callerKnown: "false" });
  });
});

// ---------------------------------------------------------------------------
describe("create_incident", () => {
  it("logs a high-urgency incident for a caller who cannot work", async () => {
    fake.addUser();
    const result = await handler(flowEvent({ action: "create_incident", category: "1", urgent: "1" }));

    expect(result).toMatchObject({ status: "created", reason: "", ticketType: "incident" });
    expect(result.ticketNumber).toMatch(/^INC\d{7}$/);
    expect(result.ticketSpoken).toBe(result.ticketNumber?.replace(/\D/g, "").split("").join(" "));
    expect(result.agentSummary).toContain("Caller says it stops them working");
    expect(result.agentSummary).toContain("Caller not verified");

    const post = fake.callsTo("POST", "/api/now/table/incident")[0];
    expect(post?.body).toMatchObject({
      contact_type: "phone",
      category: "software",
      impact: "2",
      urgency: "1",
      caller_id: USER_SYS_ID,
      correlation_id: CONTACT_ID,
      correlation_display: "Amazon Connect",
    });
  });

  it("says on the record that the caller was matched by phone number only", async () => {
    fake.addUser();
    await handler(flowEvent({ action: "create_incident", category: "2", urgent: "2" }));
    const post = fake.callsTo("POST", "/api/now/table/incident")[0];
    expect(post?.body?.description).toContain("by phone number only. Identity not verified");
    expect(post?.body).toMatchObject({ category: "network", impact: "3", urgency: "2" });
  });

  it("still logs an incident for a caller nobody recognises, with the number for call-back", async () => {
    const result = await handler(flowEvent({ action: "create_incident", category: "3", urgent: "2" }));
    expect(result.status).toBe("created");
    const post = fake.callsTo("POST", "/api/now/table/incident")[0];
    expect(post?.body).not.toHaveProperty("caller_id");
    expect(post?.body?.description).toContain(CALLER);
  });

  it("does not put a withheld number on the record, and still logs the incident", async () => {
    const result = await handler(flowEvent({ action: "create_incident" }, { address: null }));
    expect(result.status).toBe("created");
    const post = fake.callsTo("POST", "/api/now/table/incident")[0];
    expect(post?.body?.description).toContain("withheld");
    expect(fake.callsTo("GET", "/api/now/table/sys_user")).toHaveLength(0);
  });

  it.each([undefined, "", "9", "constructor", "__proto__", "toString"])(
    "treats a menu key that means nothing (%j) as 'other'",
    async (category) => {
      const params: Record<string, string> = { action: "create_incident" };
      if (category !== undefined) params.category = category;
      const result = await handler(flowEvent(params));
      expect(result.status).toBe("created");
      expect(fake.callsTo("POST", "/api/now/table/incident")[0]?.body?.category).toBe("inquiry");
    },
  );

  it("is safe to repeat: the same call gets the same incident, not a second one", async () => {
    const first = await handler(flowEvent({ action: "create_incident", category: "1", urgent: "1" }));
    const second = await handler(flowEvent({ action: "create_incident", category: "1", urgent: "1" }));

    expect(second.status).toBe("existing");
    expect(second.ticketNumber).toBe(first.ticketNumber);
    expect(fake.callsTo("POST", "/api/now/table/incident")).toHaveLength(1);
  });

  it.each([
    ["a bad password", () => jsonResponse(401, {}), "error", "http_401"],
    ["a missing role", () => jsonResponse(403, {}), "error", "http_403"],
    ["a ServiceNow outage", () => jsonResponse(503, {}), "degraded", "http_503"],
    ["throttling", () => jsonResponse(429, {}), "degraded", "http_429"],
    [
      "a sleeping instance (an HTML page)",
      () => new Response("<html>Instance Hibernating</html>", { status: 200 }),
      "degraded",
      "bad_response",
    ],
  ])("returns a usable answer for %s, and never throws", async (_name, make, status, reason) => {
    fake.override = make;
    const result = await handler(flowEvent({ action: "create_incident", category: "1" }));
    expect(result).toMatchObject({ status, reason, ticketNumber: "", ticketSpoken: "" });
    expect(allStrings(result)).toBe(true);
  });

  it("returns 'timeout' as degraded when ServiceNow does not answer in time", async () => {
    fake.override = () => {
      throw timeoutError();
    };
    const result = await handler(flowEvent({ action: "create_incident" }));
    expect(result).toMatchObject({ status: "degraded", reason: "timeout" });
  });

  it("gives up before calling anyone when the time budget is already spent", async () => {
    process.env.SERVICENOW_TOTAL_BUDGET_SEC = "0";
    const result = await handler(flowEvent({ action: "create_incident" }));
    expect(result).toMatchObject({ status: "degraded", reason: "budget_exhausted" });
    expect(fake.calls).toHaveLength(0);
  });

  it("reports a missing environment variable instead of crashing", async () => {
    delete process.env.SERVICENOW_SECRET_ID;
    const result = await handler(flowEvent({ action: "create_incident" }));
    expect(result).toMatchObject({ status: "error", reason: "secret_env_missing" });
  });

  it("treats any failure of the network call as a network problem, not a crash", async () => {
    fake.override = () => {
      throw new TypeError("fetch failed");
    };
    const result = await handler(flowEvent({ action: "create_incident" }));
    expect(result).toMatchObject({ status: "degraded", reason: "network" });
  });

  it("re-throws a real bug so the flow's Error branch and the alarms see it", async () => {
    const buggy = {
      get Details(): never {
        throw new Error("a bug, not a ServiceNow problem");
      },
    };
    await expect(handler(buggy)).rejects.toThrow("a bug");
  });
});

// ---------------------------------------------------------------------------
describe("create_request", () => {
  const ask = (extra: Record<string, string> = {}, opts?: Parameters<typeof flowEvent>[1]) =>
    flowEvent({ action: "create_request", requestType: "2", digits: RIGHT_DIGITS, ...extra }, opts);

  it("raises a request for a verified caller, in that caller's name", async () => {
    fake.addUser();
    const result = await handler(ask());

    expect(result).toMatchObject({ status: "created", ticketType: "request" });
    expect(result.ticketNumber).toMatch(/^REQ\d{7}$/);
    expect(result.agentSummary).toContain("Caller verified");
    expect(result.agentSummary).toContain("equipment request");

    const post = fake.callsTo("POST", "/api/now/table/sc_request")[0];
    expect(post?.body).toMatchObject({
      requested_for: USER_SYS_ID,
      contact_type: "phone",
      correlation_id: CONTACT_ID,
      correlation_display: "Amazon Connect",
    });
    expect(post?.body?.short_description).toBe("Phone request: equipment request");
    expect(post?.body?.work_notes).toContain("Caller verified");
  });

  it("refuses a wrong digit and never creates the request or touches the ticket tables", async () => {
    fake.addUser();
    const result = await handler(ask({ digits: WRONG_DIGITS }));

    expect(result).toMatchObject({ status: "verification_failed", reason: "wrong_digits", ticketNumber: "" });
    expect(ticketCalls()).toHaveLength(0);
  });

  it("refuses a caller ServiceNow does not recognise", async () => {
    const result = await handler(ask());
    expect(result).toMatchObject({ status: "not_recognised", reason: "no_match" });
    expect(ticketCalls()).toHaveLength(0);
  });

  it("refuses a withheld number without calling ServiceNow", async () => {
    const result = await handler(ask({}, { address: null }));
    expect(result).toMatchObject({ status: "not_recognised", reason: "withheld_number" });
    expect(fake.calls).toHaveLength(0);
  });

  it("never passes a user who has no customer number on record", async () => {
    fake.addUser({ employee_number: "" });
    for (const digits of [RIGHT_DIGITS, "0000", ""]) {
      const result = await handler(ask({ digits }, { contactId: `aaaaaaaa-0000-0000-0000-${digits.padEnd(12, "0")}` }));
      expect(result.status).toBe("verification_failed");
      expect(["no_reference", "bad_input"]).toContain(result.reason);
    }
    expect(fake.callsTo("POST", "/api/now/table/sc_request")).toHaveLength(0);
  });

  it.each(["", "135", "13578", "13a7", "    "])("refuses digits that are not four digits: %j", async (digits) => {
    fake.addUser();
    const result = await handler(ask({ digits }));
    expect(result).toMatchObject({ status: "verification_failed", reason: "bad_input" });
    expect(ticketCalls()).toHaveLength(0);
  });

  it.each([undefined, "", "0", "9", "constructor"])("refuses an unknown request type (%j) before any call", async (requestType) => {
    const params: Record<string, string> = { action: "create_request", digits: RIGHT_DIGITS };
    if (requestType !== undefined) params.requestType = requestType;
    const result = await handler(flowEvent(params));
    expect(result).toMatchObject({ status: "error", reason: "unknown_request_type" });
    expect(fake.calls).toHaveLength(0);
  });

  it("is safe to repeat: the same call gets the same request", async () => {
    fake.addUser();
    const first = await handler(ask());
    const second = await handler(ask());

    expect(second.status).toBe("existing");
    expect(second.ticketNumber).toBe(first.ticketNumber);
    expect(fake.callsTo("POST", "/api/now/table/sc_request")).toHaveLength(1);
  });

  it("still verifies before returning an existing request", async () => {
    fake.addUser();
    await handler(ask());
    const second = await handler(ask({ digits: WRONG_DIGITS }));
    expect(second.status).toBe("verification_failed");
  });

  it("returns a usable answer when ServiceNow is down", async () => {
    fake.override = () => jsonResponse(503, {});
    const result = await handler(ask());
    expect(result).toMatchObject({ status: "degraded", reason: "http_503" });
    expect(allStrings(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("status", () => {
  const ask = (extra: Record<string, string> = {}, opts?: Parameters<typeof flowEvent>[1]) =>
    flowEvent({ action: "status", kind: "1", number: "0010007", digits: RIGHT_DIGITS, ...extra }, opts);

  it("reads back the state of the caller's own incident", async () => {
    fake.addUser();
    seedTicket("incident", { state: "2" });
    const result = await handler(ask());
    expect(result).toMatchObject({ status: "found", ticketType: "incident", statusText: "In Progress" });
    expect(result.ticketSpoken).toBe("0 0 1 0 0 0 7");
  });

  it("reads back the state of the caller's own request", async () => {
    fake.addUser();
    seedTicket("request", { request_state: "approved", state: "1" });
    const result = await handler(ask({ kind: "2" }));
    expect(result).toMatchObject({ status: "found", ticketType: "request", statusText: "Approved" });
  });

  it("falls back to the task state, then to an honest 'not available'", async () => {
    fake.addUser();
    seedTicket("request", { request_state: "something_new", state: "3" });
    expect((await handler(ask({ kind: "2" }))).statusText).toBe("Closed, complete");

    fake.requests.length = 0;
    seedTicket("request", { request_state: "", state: "99" });
    expect((await handler(ask({ kind: "2" }))).statusText).toBe("not available right now");
  });

  it("refuses a wrong digit and does not touch the ticket tables at all", async () => {
    fake.addUser();
    seedTicket("incident");
    const result = await handler(ask({ digits: WRONG_DIGITS }));

    expect(result).toMatchObject({ status: "verification_failed", reason: "wrong_digits", statusText: "" });
    expect(ticketCalls()).toHaveLength(0);
  });

  it("refuses a caller ServiceNow does not recognise without touching the ticket tables", async () => {
    seedTicket("incident");
    const result = await handler(ask());
    expect(result.status).toBe("not_recognised");
    expect(ticketCalls()).toHaveLength(0);
  });

  it("gives the SAME answer for a ticket that is not yours as for one that does not exist", async () => {
    fake.addUser();
    fake.addUser({ sys_id: OTHER_SYS_ID, name: "Someone Else", mobile_phone: OTHER_CALLER, employee_number: "99990000" });
    seedTicket("incident", { number: "INC0010007", owner: OTHER_SYS_ID }); // someone else's
    seedTicket("incident", { sys_id: "d".repeat(32), number: "INC0010008", owner: USER_SYS_ID }); // mine

    const notMine = await handler(ask({ number: "0010007" }));
    const missing = await handler(ask({ number: "0099999" }));

    expect(notMine).toEqual(missing);
    expect(notMine).toMatchObject({ status: "not_found", reason: "no_match", statusText: "" });
    // And it did not leak the other person's ticket.
    expect(JSON.stringify(notMine)).not.toContain("INC0010007");
  });

  it("keeps an incident number and a request number apart", async () => {
    fake.addUser();
    seedTicket("incident", { number: "INC0010007" });
    const result = await handler(ask({ kind: "2" })); // asks the REQUEST table for 0010007
    expect(result).toMatchObject({ status: "not_found", reason: "no_match" });
  });

  it.each([
    ["letters", { number: "abc1234" }],
    ["too short", { number: "12345" }],
    ["too long", { number: "00100071" }],
    ["no number", { number: "" }],
    ["a ServiceNow query injection", { number: "1^ORactive=true" }],
    ["no kind", { kind: "" }],
    ["a kind that is not a key", { kind: "constructor" }],
  ])("refuses %s before any call", async (_name, extra) => {
    const result = await handler(ask(extra));
    expect(result).toMatchObject({ status: "not_found", reason: "invalid_number" });
    expect(fake.calls).toHaveLength(0);
  });

  it("returns a usable answer when ServiceNow is down", async () => {
    fake.addUser();
    fake.override = (c) => (c.path.includes("incident") ? jsonResponse(503, {}) : undefined);
    const result = await handler(ask());
    expect(result).toMatchObject({ status: "degraded", reason: "http_503" });
    expect(allStrings(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("call ended (EventBridge)", () => {
  it("adds a work note to the incident the call created", async () => {
    await handler(flowEvent({ action: "create_incident", category: "1" }));
    const result = await handler(disconnectEvent());

    expect(result).toMatchObject({ status: "updated" });
    const note = fake.incidents[0]?.work_notes.at(-1) ?? "";
    expect(note).toContain("the call has ended");
    expect(note).toContain("Duration: 125 seconds");
    expect(note).toContain("Handled by an agent: yes");
  });

  it("adds a work note to the request the call created", async () => {
    fake.addUser();
    await handler(flowEvent({ action: "create_request", requestType: "1", digits: RIGHT_DIGITS }));
    const result = await handler(disconnectEvent());

    expect(result.status).toBe("updated");
    expect(fake.requests[0]?.work_notes.at(-1)).toContain("the call has ended");
    expect(fake.callsTo("PATCH", `/api/now/table/sc_request/${fake.requests[0]?.sys_id}`)).toHaveLength(1);
  });

  it("does nothing, quietly, when the call made no ticket", async () => {
    const result = await handler(disconnectEvent());
    expect(result).toMatchObject({ status: "no_ticket" });
    expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("ignores events that are not a voice disconnect", async () => {
    expect((await handler(disconnectEvent({ eventType: "INITIATED" }))).reason).toBe("not_disconnected");
    expect((await handler(disconnectEvent({ channel: "CHAT" }))).reason).toBe("not_voice");
    expect((await handler(disconnectEvent({ contactId: "x^y" }))).reason).toBe("no_contact_id");
    expect(fake.calls).toHaveLength(0);
  });

  it("throws on a temporary ServiceNow problem, so Lambda retries", async () => {
    await handler(flowEvent({ action: "create_incident" }));
    fake.override = (c) => (c.method === "PATCH" ? jsonResponse(503, {}) : undefined);
    await expect(handler(disconnectEvent())).rejects.toMatchObject({ reason: "http_503" });
  });

  it("does not throw on a permanent problem, since a retry cannot fix it", async () => {
    await handler(flowEvent({ action: "create_incident" }));
    fake.override = (c) => (c.method === "PATCH" ? jsonResponse(403, {}) : undefined);
    const result = await handler(disconnectEvent());
    expect(result).toMatchObject({ status: "error", reason: "http_403" });
  });
});

// ---------------------------------------------------------------------------
describe("secrets and what reaches the log", () => {
  it("never logs a password, keyed digits, a customer number, a full number or a name", async () => {
    const out = captureConsole();
    fake.addUser();
    seedTicket("incident");

    await handler(flowEvent({ action: "identify" }));
    await handler(flowEvent({ action: "create_incident", category: "1", urgent: "1" }));
    await handler(flowEvent({ action: "create_request", requestType: "1", digits: RIGHT_DIGITS }, { contactId: "eeeeeeee-1111-2222-3333-444444444444" }));
    await handler(flowEvent({ action: "create_request", requestType: "1", digits: WRONG_DIGITS }, { contactId: "ffffffff-1111-2222-3333-444444444444" }));
    await handler(flowEvent({ action: "status", kind: "1", number: "0010007", digits: RIGHT_DIGITS }));
    await handler(flowEvent({ action: "status", kind: "1", number: "0010007", digits: WRONG_DIGITS }));
    await handler(disconnectEvent());
    await handler(flowEvent({ action: "identify" }, { address: "+61355500999" }));

    const log = out.text();
    expect(log.length).toBeGreaterThan(200);
    for (const secret of [PASSWORD, RIGHT_DIGITS, WRONG_DIGITS, CUSTOMER_REF, "48201357", CALLER, OTHER_CALLER, "Test Caller Lab"]) {
      expect(log, `the log must not contain ${secret}`).not.toContain(secret);
    }
    // Only the last four digits of the number may appear.
    expect(log).toContain("0101");
  });

  it("writes audit events that use only the closed list of fields", async () => {
    const out = captureConsole();
    fake.addUser();
    seedTicket("incident");

    await handler(flowEvent({ action: "identify" }));
    await handler(flowEvent({ action: "create_request", requestType: "1", digits: RIGHT_DIGITS }));
    await handler(flowEvent({ action: "status", kind: "1", number: "0010007", digits: WRONG_DIGITS }));
    await handler(flowEvent({ action: "status", kind: "1", number: "0010007", digits: RIGHT_DIGITS }));

    const events = out
      .lines()
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .filter((e) => e.audit === true);

    const names = events.map((e) => e.auditEvent);
    expect(names).toEqual(
      expect.arrayContaining(["caller_identified", "verification_passed", "request_created", "verification_failed", "status_read"]),
    );

    const allowed = new Set([
      "level", "message", "timestamp", "service", "sampling_rate", "xray_trace_id", // Powertools' own keys
      "audit", "auditEvent", "contactId", "callerLast4", "reason", "ticketType", "ticketNumber",
    ]);
    for (const e of events) {
      for (const key of Object.keys(e)) expect(allowed, `unexpected audit field ${key}`).toContain(key);
    }
  });

  it("records WHY a verification failed, not what was typed", async () => {
    const out = captureConsole();
    fake.addUser();
    await handler(flowEvent({ action: "create_request", requestType: "1", digits: WRONG_DIGITS }));
    const failed = out
      .lines()
      .map((l) => JSON.parse(l.startsWith("{") ? l : "{}") as Record<string, unknown>)
      .find((e) => e.auditEvent === "verification_failed");
    expect(failed).toMatchObject({ reason: "wrong_digits", callerLast4: "0101", contactId: CONTACT_ID });
  });

  it("emits the metrics the alarms are built on", async () => {
    const out = captureConsole();
    fake.addUser();
    await handler(flowEvent({ action: "create_request", requestType: "1", digits: RIGHT_DIGITS }));
    await handler(flowEvent({ action: "create_request", requestType: "1", digits: WRONG_DIGITS }, { contactId: "ffffffff-1111-2222-3333-444444444444" }));
    await handler(flowEvent({ action: "create_incident" }));
    const log = out.text();
    for (const name of ["RequestCreated", "VerificationPassed", "VerificationFailed", "IncidentCreated", "HandlerLatencyMs"]) {
      expect(log, name).toContain(name);
    }
  });

  it.each([
    ["not JSON", "{oops", "secret_invalid_json"],
    ["empty", "{}", "secret_missing_keys"],
    ["a basic secret with no password", JSON.stringify({ instance_url: "https://dev12345.service-now.com", username: "u" }), "secret_missing_keys"],
  ])("returns a clear reason for a bad secret: %s", async (_n, text, reason) => {
    ({ fake } = install(text));
    const result = await handler(flowEvent({ action: "identify" }));
    expect(result).toMatchObject({ status: "error", reason });
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    "http://dev12345.service-now.com",
    "https://evil.example.com",
    "https://dev12345.service-now.com.evil.example.com",
    "https://user:pass@dev12345.service-now.com",
  ])("never sends the password to %s", async (instanceUrl) => {
    ({ fake } = install(JSON.stringify({ instance_url: instanceUrl, username: "u", password: PASSWORD })));
    const result = await handler(flowEvent({ action: "identify" }));
    expect(result).toMatchObject({ status: "error", reason: "instance_url_not_servicenow" });
    expect(fake.calls).toHaveLength(0);
  });

  it("reads the secret once and reuses it while the container is warm", async () => {
    let reads = 0;
    ({ fake } = install(async () => {
      reads += 1;
      return JSON.stringify({ instance_url: "https://dev12345.service-now.com", username: "u", password: PASSWORD });
    }));
    await handler(flowEvent({ action: "identify" }));
    await handler(flowEvent({ action: "identify" }));
    expect(reads).toBe(1);
  });

  it("reports an unreachable secret store instead of crashing", async () => {
    ({ fake } = install(async () => {
      throw new Error("AccessDenied");
    }));
    const result = await handler(flowEvent({ action: "identify" }));
    expect(result).toMatchObject({ status: "error", reason: "secret_unreachable" });
  });

  it("rejects an unknown action without calling anyone", async () => {
    const result = await handler(flowEvent({ action: "drop_tables" }));
    expect(result).toMatchObject({ status: "error", reason: "unknown_action" });
    expect(fake.calls).toHaveLength(0);
    expect((await handler(flowEvent({}))).reason).toBe("unknown_action");
    expect((await handler(null)).reason).toBe("unknown_action");
  });
});
