// Unit tests for the Contact Lens route: a Contact Lens rule matches, EventBridge
// sends the event here, and the function adds a note to the call's ticket or
// opens an incident if the call has none.
//
// Fake ServiceNow only. What these cannot prove: that Amazon Connect really sends
// this event name and shape (the two AWS pages disagree on the name, so both are
// accepted), or that a real ServiceNow accepts the fields. The live session does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "../src/handler";
import { CONTACT_ID, FakeServiceNow, PASSWORD, captureConsole, flowEvent, install, jsonResponse, lensEvent } from "./helpers";

let fake: FakeServiceNow;

beforeEach(() => {
  ({ fake } = install());
  process.env.LENS_TICKET_RULES = "Negative-Sentiment,Escalation,Complaint";
  process.env.LENS_OPEN_RULES = "Negative-Sentiment";
});

afterEach(() => {
  delete process.env.LENS_TICKET_RULES;
  delete process.env.LENS_OPEN_RULES;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Contact Lens rule matched", () => {
  it("opens an incident when the call has no ticket", async () => {
    const result = await handler(lensEvent());

    expect(result).toMatchObject({ status: "created", reason: "" });
    expect(result.ticketNumber).toMatch(/^INC\d{7}$/);
    expect(fake.incidents).toHaveLength(1);
    const posted = fake.callsTo("POST", "/api/now/table/incident")[0]?.body ?? {};
    expect(posted.short_description).toBe("Contact Lens: Negative-Sentiment call");
    expect(posted.correlation_id).toBe(CONTACT_ID);
    expect(posted.contact_type).toBe("phone");
    expect(posted.description).toContain("No caller was identified or verified");
  });

  it("adds a note to the ticket the call already made, and opens no second one", async () => {
    await handler(flowEvent({ action: "create_incident", category: "1" }));
    const result = await handler(lensEvent());

    expect(result.status).toBe("updated");
    expect(fake.incidents).toHaveLength(1);
    expect(fake.incidents[0]?.work_notes.at(-1)).toContain('rule "Negative-Sentiment" matched');
    expect(fake.callsTo("POST", "/api/now/table/incident")).toHaveLength(1); // the menu one only
  });

  it("notes a request too", async () => {
    fake.addUser();
    await handler(flowEvent({ action: "create_request", requestType: "1", digits: "1357" }));
    expect((await handler(lensEvent({ ruleName: "Escalation" }))).status).toBe("updated");
    expect(fake.requests[0]?.work_notes.at(-1)).toContain('"Escalation"');
  });

  it("a rule that may not open tickets adds a note when the ticket exists, and waits (retryable) when it does not", async () => {
    await expect(handler(lensEvent({ ruleName: "Complaint" }))).rejects.toMatchObject({ reason: "ticket_not_yet" });
    expect(fake.incidents).toHaveLength(0);
    expect(fake.callsTo("POST", "/api/now/table/incident")).toHaveLength(0);

    await handler(lensEvent()); // the opening rule makes the incident
    expect((await handler(lensEvent({ ruleName: "Complaint" }))).status).toBe("updated");
    expect(fake.incidents).toHaveLength(1);
    expect(fake.incidents[0]?.work_notes.at(-1)).toContain('"Complaint"');
  });

  it("two rules matching one call open exactly one incident when only one may open", async () => {
    // Complaint arrives first (before the incident exists): it waits. Then the opener runs. Then a retry.
    await expect(handler(lensEvent({ ruleName: "Complaint" }))).rejects.toBeTruthy();
    await handler(lensEvent());
    await handler(lensEvent({ ruleName: "Complaint" }));
    expect(fake.incidents).toHaveLength(1);
  });

  it("is safe to repeat: the same event twice makes one incident", async () => {
    await handler(lensEvent());
    const second = await handler(lensEvent());
    expect(second.status).toBe("updated");
    expect(fake.incidents).toHaveLength(1);
  });

  it("accepts either name AWS documents for the event, and the real-time one", async () => {
    const a = await handler(lensEvent({}, "Contact Lens Post Call Rules Matched"));
    expect(a.status).toBe("created");
    const b = await handler(lensEvent({}, "conversational analytics Realtime Rules Matched"));
    expect(b.status).toBe("updated");
    expect(fake.incidents[0]?.work_notes.at(-1)).toContain("real-time rule");
    const c = await handler(lensEvent({}, "Contact Lens Realtime Rules Matched"));
    expect(c.status).toBe("updated");
  });

  it("does nothing while the route is off (no allow list)", async () => {
    delete process.env.LENS_TICKET_RULES;
    expect(await handler(lensEvent())).toMatchObject({ status: "ignored", reason: "lens_route_off" });
    expect(fake.calls).toHaveLength(0);
  });

  it("ignores a rule that is not on the allow list, and a bad rule name", async () => {
    expect((await handler(lensEvent({ ruleName: "Refund-Request" }))).reason).toBe("rule_not_allowed");
    expect((await handler(lensEvent({ ruleName: "Complaint^ORnumber=1" }))).reason).toBe("rule_not_allowed");
    expect((await handler(lensEvent({ ruleName: "" }))).reason).toBe("rule_not_allowed");
    expect(fake.calls).toHaveLength(0);
  });

  it("ignores an event with no usable contact", async () => {
    expect((await handler(lensEvent({ contactArn: "arn:aws:connect:x:y:instance/z" }))).reason).toBe("no_contact_id");
    expect((await handler(lensEvent({ contactArn: undefined }))).reason).toBe("no_contact_id");
    expect(fake.calls).toHaveLength(0);
  });

  it("ignores other events that merely look similar", async () => {
    const other = lensEvent({}, "Contact Lens Evaluation Rules Matched");
    const result = await handler(other);
    expect(result).toMatchObject({ status: "error", reason: "unknown_action" });
    expect(fake.calls).toHaveLength(0);
  });

  it("throws on a temporary ServiceNow problem so Lambda retries, not on a permanent one", async () => {
    fake.override = (c) => (c.method === "POST" ? jsonResponse(503, {}) : undefined);
    await expect(handler(lensEvent())).rejects.toMatchObject({ reason: "http_503" });
    fake.override = (c) => (c.method === "POST" ? jsonResponse(403, {}) : undefined);
    expect(await handler(lensEvent())).toMatchObject({ status: "error", reason: "http_403" });
  });

  it("returns only strings, and logs no secret", async () => {
    const log = captureConsole();
    const result = await handler(lensEvent());
    expect(Object.values(result).every((v) => typeof v === "string")).toBe(true);
    expect(log.text()).not.toContain(PASSWORD);
    expect(log.text()).toContain("lens_ticket_created");
  });

  it("keeps odd characters in the action name out of the ticket", async () => {
    await handler(lensEvent({ actionName: "x\nINJECT=1^OR" }));
    const description = fake.callsTo("POST", "/api/now/table/incident")[0]?.body?.description ?? "";
    expect(description).not.toContain("^");
    expect(description).not.toContain("INJECT=1");
  });
});
