// Service desk Lambda for an Amazon Connect contact flow.
//
// One function, five jobs, chosen by the "action" the flow passes in:
//
//   identify         Who is calling? Match the caller ID to a ServiceNow user.
//                    The answer is "known or not". The NAME is not spoken to the
//                    caller: caller ID can be faked, so naming the person on an
//                    unverified call would leak who owns that number.
//
//   create_incident  "Something is broken." Anyone may report a problem, so no
//                    verification is needed. Logs an incident with a category and
//                    an urgency, hands the number back.
//
//   create_request   "I need something." Raises a service request in a person's
//                    name, so the caller must be recognised AND verified first.
//
//   status           Read back the state of a ticket. Verified caller only, and
//                    only a ticket that belongs to that caller.
//
//   (an event)       Amazon Connect publishes a "DISCONNECTED" contact event to
//                    EventBridge when a call ends. A rule sends it here and the
//                    function adds a work note to whichever ticket the call made.
//
//   (a second event) A Contact Lens rule (a category such as Negative-Sentiment)
//                    can publish an EventBridge event when it matches. Another
//                    rule sends that here. The function adds a note to the call's
//                    ticket, or opens an incident if the call has none yet. Only
//                    rule names on an allow list (LENS_TICKET_RULES) may do this.
//
// Rules that shape the error handling
// -----------------------------------
//   * An expected condition is NOT an error. An unknown caller, a wrong digit, a
//     typo in a ticket number and a ServiceNow outage are all returned as a
//     "status" plus a "reason". The function does not throw for them, so the
//     caller is still looked after: the flow carries on and connects them to an
//     agent. Only a bug takes the flow's Error branch.
//   * Verification is atomic. The digits arrive in the SAME call as the action
//     they protect and are checked inside it, so the function never has to trust
//     a flag the flow claims to have set earlier. The digits are never stored on
//     the contact, never logged and never returned.
//   * Not finding a ticket and not owning a ticket look identical to the caller.
//     Otherwise "that number is not yours" would confirm the number exists.
//   * create is safe to repeat. The Amazon Connect contact id is stored on the
//     ticket (correlation_id) and looked up first.
//   * Everything returned to the flow is a string (see response.ts).
//   * Every decision leaves an audit event (see telemetry.ts).
import { loadConfig } from "./config";
import type { Config } from "./config";
import { last4, normalise, PHONE_RE, phoneVariants } from "./phone";
import { flat, incidentStateText, requestStateText, spokenDigits } from "./response";
import type { FlatMap } from "./response";
import {
  addWorkNote,
  createTicket,
  Deadline,
  Fallback,
  findTicketByContactId,
  findTicketByDigits,
  findUserByPhone,
  isContactId,
  loadCredentials,
} from "./servicenow";
import type { Credentials, FoundUser, Ticket, TicketKind } from "./servicenow";
import { audit, logger, metrics, MetricUnit } from "./telemetry";
import { checkCustomerDigits } from "./verify";

// ---------------------------------------------------------------------------
// Shapes of the two kinds of event this function receives
// ---------------------------------------------------------------------------

interface FlowEvent {
  Details?: {
    Parameters?: Record<string, string | undefined>;
    ContactData?: {
      ContactId?: string;
      CustomerEndpoint?: { Address?: string };
    };
  };
}

interface ContactEvent {
  "detail-type": string;
  detail?: {
    eventType?: string;
    contactId?: string;
    channel?: string;
    initiationTimestamp?: string;
    disconnectTimestamp?: string;
    agentInfo?: { connectedToAgentTimestamp?: string };
  };
}

interface LensEvent {
  "detail-type": string;
  detail?: {
    ruleName?: string;
    actionName?: string;
    contactArn?: string;
  };
}

// The AWS pages disagree on the event's name: the Connect administrator guide says
// "conversational analytics ... Rules Matched", the EventBridge reference says
// "Contact Lens ... Rules Matched". Accept both, so the route works whichever
// name the service really sends. The first live run records which one it was.
const LENS_EVENT_TYPES: Record<string, "post-call" | "real-time"> = {
  "conversational analytics Post Call Rules Matched": "post-call",
  "Contact Lens Post Call Rules Matched": "post-call",
  "conversational analytics Realtime Rules Matched": "real-time",
  "Contact Lens Realtime Rules Matched": "real-time",
};

function isLensEvent(event: unknown): event is LensEvent {
  if (typeof event !== "object" || event === null) return false;
  const type = (event as Record<string, unknown>)["detail-type"];
  return typeof type === "string" && Object.hasOwn(LENS_EVENT_TYPES, type);
}

function isContactEvent(event: unknown): event is ContactEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as Record<string, unknown>)["detail-type"] === "Amazon Connect Contact Event"
  );
}

// ---------------------------------------------------------------------------
// What the menu keys mean
// ---------------------------------------------------------------------------

const CATEGORY: Record<string, { value: string; label: string }> = {
  "1": { value: "software", label: "software or app" },
  "2": { value: "network", label: "network or connection" },
  "3": { value: "inquiry", label: "other" },
};

const REQUEST_TYPE: Record<string, string> = {
  "1": "access request",
  "2": "equipment request",
  "3": "general information request",
};

const TICKET_KIND: Record<string, TicketKind> = { "1": "incident", "2": "request" };

/**
 * Look a menu key up in one of the maps above. Object.hasOwn matters: without
 * it a "key" of "constructor" would find a function on the prototype chain.
 */
function pick<T>(map: Record<string, T>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
}

const OTHER_CATEGORY = { value: "inquiry", label: "other" };

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

interface Who {
  caller: string;
  callerOk: boolean;
  contactId: string;
  params: Record<string, string | undefined>;
}

function whoIsCalling(event: FlowEvent): Who {
  const details = event.Details ?? {};
  const params = details.Parameters ?? {};
  const contact = details.ContactData ?? {};
  const caller = normalise(params.callerNumber || contact.CustomerEndpoint?.Address);
  return {
    caller,
    callerOk: PHONE_RE.test(caller),
    contactId: contact.ContactId && isContactId(contact.ContactId) ? contact.ContactId : "",
    params,
  };
}

function reasonOf(err: unknown): string {
  return err instanceof Fallback ? err.reason : "unexpected";
}

function ticketAnswer(status: string, ticket: Ticket, summary: string): FlatMap {
  return flat({
    status,
    reason: "",
    ticketType: ticket.kind,
    ticketNumber: ticket.number,
    ticketSpoken: spokenDigits(ticket.number),
    agentSummary: summary,
  });
}

function createFallback(status: string, reason: string): FlatMap {
  metrics.addMetric("TicketFallback", MetricUnit.Count, 1);
  return flat({ status, reason, ticketType: "", ticketNumber: "", ticketSpoken: "", agentSummary: "" });
}

// ---------------------------------------------------------------------------
// identify
// ---------------------------------------------------------------------------

async function handleIdentify(event: FlowEvent, config: Config, deadline: Deadline): Promise<FlatMap> {
  const { caller, callerOk, contactId } = whoIsCalling(event);
  const unknown = (status: string, reason: string): FlatMap =>
    flat({ status, reason, callerKnown: "false", callerMatch: "" });

  if (!callerOk) {
    audit("caller_unknown", { contactId, reason: "withheld_number" });
    metrics.addMetric("CallerUnknown", MetricUnit.Count, 1);
    return unknown("unknown", "withheld_number");
  }
  if (!config.secretId) {
    logger.error("SERVICENOW_SECRET_ID is not set");
    return unknown("error", "secret_env_missing");
  }

  try {
    const creds = await loadCredentials(config.secretId, deadline);
    const user = await findUserByPhone(creds, phoneVariants(caller), deadline);
    if (!user) {
      audit("caller_unknown", { contactId, callerLast4: last4(caller), reason: "no_match" });
      metrics.addMetric("CallerUnknown", MetricUnit.Count, 1);
      return unknown("unknown", "no_match");
    }
    audit("caller_identified", { contactId, callerLast4: last4(caller) });
    metrics.addMetric("CallerIdentified", MetricUnit.Count, 1);
    // callerMatch is for the AGENT's screen only. The flow never speaks it.
    return flat({ status: "identified", reason: "", callerKnown: "true", callerMatch: user.name });
  } catch (err) {
    if (err instanceof Fallback) {
      logger.warn("identify fell back", { contactId, reason: err.reason });
      return unknown(err.status, err.reason);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// create_incident
// ---------------------------------------------------------------------------

async function handleCreateIncident(
  event: FlowEvent,
  config: Config,
  deadline: Deadline,
): Promise<FlatMap> {
  const { caller, callerOk, contactId, params } = whoIsCalling(event);
  const category = pick(CATEGORY, params.category) ?? OTHER_CATEGORY;
  const cannotWork = params.urgent === "1";

  logger.info("create_incident start", { contactId, caller: last4(caller) });

  if (!config.secretId) {
    logger.error("SERVICENOW_SECRET_ID is not set");
    return createFallback("error", "secret_env_missing");
  }

  try {
    const creds = await loadCredentials(config.secretId, deadline);

    // The two lookups do not depend on each other, so run them side by side.
    const [userResult, existingResult] = await Promise.allSettled([
      callerOk ? findUserByPhone(creds, phoneVariants(caller), deadline) : Promise.resolve(null),
      contactId ? findTicketByContactId(creds, "incident", contactId, deadline) : Promise.resolve(null),
    ]);

    // A failed lookup is not fatal. If ServiceNow is really down or the secret is
    // wrong, the create call below fails with the same reason and says so.
    let user: FoundUser | null = null;
    if (userResult.status === "fulfilled") {
      user = userResult.value;
    } else {
      logger.warn("caller lookup failed, logging the incident without a caller", {
        reason: reasonOf(userResult.reason),
      });
    }

    if (existingResult.status === "fulfilled" && existingResult.value) {
      const existing = existingResult.value;
      audit("incident_existing", { contactId, ticketType: "incident", ticketNumber: existing.number });
      metrics.addMetric("IncidentExisting", MetricUnit.Count, 1);
      return ticketAnswer("existing", existing, incidentSummary(existing.number, category.label, cannotWork));
    }

    // ServiceNow works out the priority from impact and urgency (a business rule).
    // "Cannot work" is high urgency, medium impact; anything else is low.
    const fields: Record<string, string> = {
      short_description: `Phone call: ${category.label} problem`,
      description: [
        "Logged automatically by the Amazon Connect service desk flow.",
        `Reported problem type: ${category.label}`,
        `Caller says it stops them working: ${cannotWork ? "yes" : "no"}`,
        // The caller was NOT verified. Say so on the record, so nobody mistakes
        // a caller-ID match for proof of identity.
        user
          ? "Caller matched to a ServiceNow user by phone number only. Identity not verified."
          : `No ServiceNow user matched the caller. Number: ${callerOk ? caller : "withheld"}`,
        `Amazon Connect contact id: ${contactId || "not provided"}`,
      ].join("\n"),
      contact_type: "phone",
      category: category.value,
      impact: cannotWork ? "2" : "3",
      urgency: cannotWork ? "1" : "2",
    };
    if (contactId) {
      fields.correlation_id = contactId;
      fields.correlation_display = "Amazon Connect";
    }
    if (user) fields.caller_id = user.sysId;

    const incident = await createTicket(creds, "incident", fields, deadline);
    audit("incident_created", { contactId, ticketType: "incident", ticketNumber: incident.number });
    metrics.addMetric("IncidentCreated", MetricUnit.Count, 1);
    return ticketAnswer("created", incident, incidentSummary(incident.number, category.label, cannotWork));
  } catch (err) {
    if (err instanceof Fallback) {
      logger.warn("create_incident fell back", { contactId, reason: err.reason });
      return createFallback(err.status, err.reason);
    }
    throw err; // a bug: let the flow's Error branch and the alarms see it
  }
}

function incidentSummary(number: string, label: string, cannotWork: boolean): string {
  return `Incident ${number} logged by phone. Problem type: ${label}. ${
    cannotWork ? "Caller says it stops them working." : "Caller can still work."
  } Caller not verified.`;
}

// ---------------------------------------------------------------------------
// Verification, shared by create_request and status
// ---------------------------------------------------------------------------

type Verified =
  | { ok: true; user: FoundUser }
  | { ok: false; status: "not_recognised" | "verification_failed"; reason: string };

async function recogniseAndVerify(
  who: Who,
  creds: Credentials,
  deadline: Deadline,
): Promise<Verified> {
  const { caller, callerOk, contactId, params } = who;
  const base = { contactId, callerLast4: last4(caller) };

  const user = callerOk ? await findUserByPhone(creds, phoneVariants(caller), deadline) : null;
  if (!user) {
    audit("verification_failed", { ...base, reason: callerOk ? "no_match" : "withheld_number" });
    metrics.addMetric("VerificationFailed", MetricUnit.Count, 1);
    return { ok: false, status: "not_recognised", reason: callerOk ? "no_match" : "withheld_number" };
  }

  const result = checkCustomerDigits(user.customerRef, (params.digits ?? "").trim());
  if (result !== "ok") {
    audit("verification_failed", { ...base, reason: result });
    metrics.addMetric("VerificationFailed", MetricUnit.Count, 1);
    return { ok: false, status: "verification_failed", reason: result };
  }

  audit("verification_passed", base);
  metrics.addMetric("VerificationPassed", MetricUnit.Count, 1);
  return { ok: true, user };
}

// ---------------------------------------------------------------------------
// create_request
// ---------------------------------------------------------------------------

async function handleCreateRequest(
  event: FlowEvent,
  config: Config,
  deadline: Deadline,
): Promise<FlatMap> {
  const who = whoIsCalling(event);
  const { contactId, params } = who;
  const label = pick(REQUEST_TYPE, params.requestType);

  if (!label) {
    logger.info("create_request refused", { reason: "unknown_request_type" });
    return createFallback("error", "unknown_request_type");
  }
  if (!config.secretId) {
    logger.error("SERVICENOW_SECRET_ID is not set");
    return createFallback("error", "secret_env_missing");
  }

  try {
    const creds = await loadCredentials(config.secretId, deadline);
    const verified = await recogniseAndVerify(who, creds, deadline);
    if (!verified.ok) {
      // A failed verification is an expected answer, not a "fallback" in the
      // sense of ServiceNow being unwell, so it does not count as TicketFallback.
      return flat({
        status: verified.status,
        reason: verified.reason,
        ticketType: "",
        ticketNumber: "",
        ticketSpoken: "",
        agentSummary: "",
      });
    }

    const existing = contactId ? await findTicketByContactId(creds, "request", contactId, deadline) : null;
    if (existing) {
      audit("request_existing", { contactId, ticketType: "request", ticketNumber: existing.number });
      metrics.addMetric("RequestExisting", MetricUnit.Count, 1);
      return ticketAnswer("existing", existing, requestSummary(existing.number, label));
    }

    const fields: Record<string, string> = {
      short_description: `Phone request: ${label}`,
      description: [
        "Logged automatically by the Amazon Connect service desk flow.",
        `Request type: ${label}`,
        `Amazon Connect contact id: ${contactId || "not provided"}`,
      ].join("\n"),
      requested_for: verified.user.sysId,
      contact_type: "phone",
      work_notes: "Caller verified by Amazon Connect: phone number matched and customer number (last four digits) confirmed.",
    };
    if (contactId) {
      fields.correlation_id = contactId;
      fields.correlation_display = "Amazon Connect";
    }

    const request = await createTicket(creds, "request", fields, deadline);
    audit("request_created", { contactId, ticketType: "request", ticketNumber: request.number });
    metrics.addMetric("RequestCreated", MetricUnit.Count, 1);
    return ticketAnswer("created", request, requestSummary(request.number, label));
  } catch (err) {
    if (err instanceof Fallback) {
      logger.warn("create_request fell back", { contactId, reason: err.reason });
      return createFallback(err.status, err.reason);
    }
    throw err;
  }
}

function requestSummary(number: string, label: string): string {
  return `Request ${number} logged by phone: ${label}. Caller verified (phone number and customer number).`;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function handleStatus(event: FlowEvent, config: Config, deadline: Deadline): Promise<FlatMap> {
  const who = whoIsCalling(event);
  const { contactId, params } = who;
  const kind = pick(TICKET_KIND, params.kind);
  const digits = (params.number ?? "").trim();
  const answer = (status: string, reason: string): FlatMap =>
    flat({ status, reason, ticketSpoken: "", statusText: "", ticketType: kind ?? "" });

  // ServiceNow numbers are INC or REQ plus seven digits. Check before going anywhere.
  if (!kind || !/^\d{7}$/.test(digits)) {
    logger.info("status check refused", { reason: "invalid_number" });
    return answer("not_found", "invalid_number");
  }
  if (!config.secretId) {
    logger.error("SERVICENOW_SECRET_ID is not set");
    return answer("error", "secret_env_missing");
  }

  try {
    const creds = await loadCredentials(config.secretId, deadline);
    const verified = await recogniseAndVerify(who, creds, deadline);
    if (!verified.ok) return answer(verified.status, verified.reason);

    // Only now, with the caller proven, is the ticket looked up.
    const ticket = await findTicketByDigits(creds, kind, digits, deadline);
    metrics.addMetric("StatusLookup", MetricUnit.Count, 1);

    // Missing and "belongs to someone else" give the SAME answer on purpose.
    if (!ticket || ticket.ownerSysId !== verified.user.sysId) {
      audit("status_refused", { contactId, ticketType: kind, reason: ticket ? "not_owner" : "no_match" });
      return answer("not_found", "no_match");
    }

    audit("status_read", { contactId, ticketType: kind, ticketNumber: ticket.number });
    return flat({
      status: "found",
      reason: "",
      ticketType: kind,
      ticketSpoken: spokenDigits(ticket.number),
      statusText:
        kind === "incident" ? incidentStateText(ticket.state) : requestStateText(ticket.requestState, ticket.state),
    });
  } catch (err) {
    if (err instanceof Fallback) {
      logger.warn("status check fell back", { contactId, reason: err.reason });
      return answer(err.status, err.reason);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// call ended (EventBridge)
// ---------------------------------------------------------------------------

async function handleDisconnect(
  event: ContactEvent,
  config: Config,
  deadline: Deadline,
): Promise<FlatMap> {
  const detail = event.detail ?? {};

  // The rule only sends DISCONNECTED, but check: a wrong rule must not write notes.
  if (detail.eventType !== "DISCONNECTED") {
    return flat({ status: "ignored", reason: "not_disconnected" });
  }
  if (detail.channel && detail.channel !== "VOICE") {
    return flat({ status: "ignored", reason: "not_voice" });
  }
  const contactId = detail.contactId ?? "";
  if (!isContactId(contactId)) {
    logger.warn("disconnect event without a usable contact id");
    return flat({ status: "ignored", reason: "no_contact_id" });
  }
  if (!config.secretId) {
    logger.error("SERVICENOW_SECRET_ID is not set");
    return flat({ status: "error", reason: "secret_env_missing" });
  }

  try {
    const creds = await loadCredentials(config.secretId, deadline);

    // One call creates at most one ticket, so look for an incident, then a request.
    const ticket =
      (await findTicketByContactId(creds, "incident", contactId, deadline)) ??
      (await findTicketByContactId(creds, "request", contactId, deadline));
    if (!ticket) {
      // Normal: the caller only checked a ticket, or reached an agent without one.
      logger.info("no ticket for this contact, nothing to update", { contactId });
      return flat({ status: "no_ticket", reason: "" });
    }

    await addWorkNote(creds, ticket.kind, ticket.sysId, workNote(detail), deadline);
    audit("call_ended_note", { contactId, ticketType: ticket.kind, ticketNumber: ticket.number });
    metrics.addMetric("WorkNoteAdded", MetricUnit.Count, 1);
    return flat({ status: "updated", reason: "" });
  } catch (err) {
    if (err instanceof Fallback) {
      metrics.addMetric("WorkNoteFailed", MetricUnit.Count, 1);
      logger.warn("work note failed", { contactId, reason: err.reason });
      // This runs without a caller waiting. If ServiceNow is only struggling,
      // throw so Lambda retries (see the event invoke config in Terraform). If
      // the cause is permanent, such as a bad secret, retrying cannot help.
      if (err.retryable) throw err;
      return flat({ status: err.status, reason: err.reason });
    }
    throw err;
  }
}

/** The note text. No names, numbers or agent identity: just what happened. */
function workNote(detail: NonNullable<ContactEvent["detail"]>): string {
  const start = Date.parse(detail.initiationTimestamp ?? "");
  const end = Date.parse(detail.disconnectTimestamp ?? "");
  const seconds =
    Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : null;
  const agent = detail.agentInfo?.connectedToAgentTimestamp ? "yes" : "no";
  const length = seconds === null ? "" : ` Duration: ${seconds} seconds.`;
  return `Amazon Connect: the call has ended.${length} Handled by an agent: ${agent}.`;
}

// ---------------------------------------------------------------------------
// Contact Lens rule matched (EventBridge)
// ---------------------------------------------------------------------------

// Connect only allows these characters in a rule name. Checking it again here
// means a name can never carry anything odd into a ServiceNow note.
const RULE_NAME_RE = /^[0-9A-Za-z._-]{1,64}$/;
const CONTACT_ARN_RE = /\/contact\/([A-Za-z0-9-]{8,64})$/;

async function handleLensRule(event: LensEvent, config: Config, deadline: Deadline): Promise<FlatMap> {
  const when = LENS_EVENT_TYPES[event["detail-type"]] ?? "post-call";
  const detail = event.detail ?? {};
  const ruleName = detail.ruleName ?? "";
  // Records which of the two documented event names really arrives (a fixed list,
  // so safe to log) and which rule it was. The first live run reads this.
  logger.info("lens event received", { detailType: event["detail-type"], when, ruleName: ruleName.slice(0, 40) });

  if (config.lensRules.length === 0) {
    return flat({ status: "ignored", reason: "lens_route_off" });
  }
  // Only rules on the allow list may touch a ticket: a wrong rule must not write.
  if (!RULE_NAME_RE.test(ruleName) || !config.lensRules.includes(ruleName)) {
    logger.info("lens rule not on the allow list", { ruleName: ruleName.slice(0, 40) });
    return flat({ status: "ignored", reason: "rule_not_allowed" });
  }
  const contactId = CONTACT_ARN_RE.exec(detail.contactArn ?? "")?.[1] ?? "";
  if (!isContactId(contactId)) {
    logger.warn("lens event without a usable contact id");
    return flat({ status: "ignored", reason: "no_contact_id" });
  }
  if (!config.secretId) {
    logger.error("SERVICENOW_SECRET_ID is not set");
    return flat({ status: "error", reason: "secret_env_missing" });
  }

  const note = `Amazon Connect Contact Lens: the ${when} rule "${ruleName}" matched this call.`;

  try {
    const creds = await loadCredentials(config.secretId, deadline);
    const existing =
      (await findTicketByContactId(creds, "incident", contactId, deadline)) ??
      (await findTicketByContactId(creds, "request", contactId, deadline));

    if (existing) {
      await addWorkNote(creds, existing.kind, existing.sysId, note, deadline);
      audit("lens_note", { contactId, ticketType: existing.kind, ticketNumber: existing.number, reason: ruleName });
      metrics.addMetric("LensNoteAdded", MetricUnit.Count, 1);
      return flat({ status: "updated", reason: "", ticketNumber: existing.number });
    }

    // No ticket yet. Only an "opening" rule may start one. Any other rule waits:
    // its event can arrive a moment before the opening rule's incident exists, so
    // fail in a retryable way and let Lambda try again (about a minute later).
    if (!config.lensOpenRules.includes(ruleName)) {
      logger.info("lens rule matched but the call has no ticket yet", { contactId, ruleName });
      throw new Fallback("ticket_not_yet", "degraded");
    }

    // The call never reported a problem through the menu, but Contact Lens says
    // it was a call that matters. Open an incident.
    const incident = await createTicket(
      creds,
      "incident",
      {
        short_description: `Contact Lens: ${ruleName} call`,
        description: [
          "Opened automatically from an Amazon Connect Contact Lens rule match.",
          `Rule: ${ruleName}`,
          `Detected: ${when}`,
          `Action name: ${(detail.actionName ?? "").replace(/[^0-9A-Za-z._ -]/g, "").slice(0, 60) || "not provided"}`,
          "No caller was identified or verified by this route.",
          `Amazon Connect contact id: ${contactId}`,
        ].join("\n"),
        contact_type: "phone",
        category: "inquiry",
        impact: "3",
        urgency: "2",
        correlation_id: contactId,
        correlation_display: "Amazon Connect",
      },
      deadline,
    );
    audit("lens_ticket_created", { contactId, ticketType: "incident", ticketNumber: incident.number, reason: ruleName });
    metrics.addMetric("LensTicketCreated", MetricUnit.Count, 1);
    return flat({ status: "created", reason: "", ticketNumber: incident.number });
  } catch (err) {
    if (err instanceof Fallback) {
      metrics.addMetric("LensRouteFailed", MetricUnit.Count, 1);
      logger.warn("lens route failed", { contactId, reason: err.reason });
      if (err.retryable) throw err; // asynchronous: let Lambda retry a temporary problem
      return flat({ status: err.status, reason: err.reason });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handler(event: unknown): Promise<FlatMap> {
  const started = performance.now();
  const config = loadConfig();
  const deadline = Deadline.start(config);

  try {
    if (isContactEvent(event)) {
      return await handleDisconnect(event, config, deadline);
    }
    if (isLensEvent(event)) {
      return await handleLensRule(event, config, deadline);
    }

    const flowEvent = (typeof event === "object" && event !== null ? event : {}) as FlowEvent;
    const action = flowEvent.Details?.Parameters?.action ?? "";

    if (action === "identify") return await handleIdentify(flowEvent, config, deadline);
    if (action === "create_incident") return await handleCreateIncident(flowEvent, config, deadline);
    if (action === "create_request") return await handleCreateRequest(flowEvent, config, deadline);
    if (action === "status") return await handleStatus(flowEvent, config, deadline);

    logger.error("unknown action", { action: String(action).slice(0, 20) });
    return flat({ status: "error", reason: "unknown_action" });
  } finally {
    metrics.addMetric("HandlerLatencyMs", MetricUnit.Milliseconds, performance.now() - started);
    metrics.publishStoredMetrics();
  }
}
