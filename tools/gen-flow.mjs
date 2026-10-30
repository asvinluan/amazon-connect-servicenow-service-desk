// Generates terraform/flows/servicedesk.json.tftpl, the Amazon Connect contact flow.
//
//   node tools/gen-flow.mjs            write the template
//   node tools/gen-flow.mjs --check    fail if the template on disk is out of date
//
// Why a generator: a flow is ~60 blocks of JSON in which every block points at the
// next one by name. By hand, one typo breaks a branch silently. Here each block is
// one line, the wiring is checked by test/flow.test.ts, and the diff of a change
// stays small. The generated file is committed, because Terraform reads it.
//
// The caller's journey (see docs/BUILD-MANUAL.md for the picture):
//
//   welcome -> identify (quietly: is this number a known user?) -> main menu
//     1 report a problem  -> kind of problem -> does it stop you working -> incident
//     2 ask for something -> (known callers only) what -> last 4 digits -> request
//     3 check a ticket    -> (known callers only) which kind -> number -> last 4 -> state
//     0 an agent
//
// Every failure path ends with the caller in the queue or, for a finished status
// check, a goodbye. Nobody is left in a dead end.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../terraform/flows/servicedesk.json.tftpl", import.meta.url));

// ---------------------------------------------------------------------------
// Block builders. Each returns [id, block]. `next` is where the block goes when
// it works; `err` is where it goes when Connect reports an error.
// ---------------------------------------------------------------------------

const blocks = [];
const add = (id, type, parameters, transitions) => {
  blocks.push({ Identifier: id, Type: type, Parameters: parameters, Transitions: transitions });
};
const errs = (target, types = ["NoMatchingError"]) => types.map((t) => ({ NextAction: target, ErrorType: t }));

const logging = (id, next) =>
  add(id, "UpdateFlowLoggingBehavior", { FlowLoggingBehavior: "Enabled" }, { NextAction: next, Errors: [], Conditions: [] });

const voice = (id, next) =>
  add(
    id,
    "UpdateContactTextToSpeechVoice",
    { TextToSpeechEngine: "Neural", TextToSpeechStyle: "None", TextToSpeechVoice: "Olivia" },
    { NextAction: next, Errors: [], Conditions: [] },
  );

const say = (id, text, next) =>
  add(id, "MessageParticipant", { Text: text }, { NextAction: next, Errors: errs(next), Conditions: [] });

const setAttrs = (id, attributes, next) =>
  add(id, "UpdateContactAttributes", { Attributes: attributes }, { NextAction: next, Errors: errs(next), Conditions: [] });

/** A one-key menu. `keys` maps a digit to a block. Anything else goes to `fallback`. */
const menu = (id, text, keys, fallback) =>
  add(
    id,
    "GetParticipantInput",
    { StoreInput: "False", InputTimeLimitSeconds: "6", Text: text },
    {
      NextAction: fallback,
      Errors: errs(fallback, ["NoMatchingCondition", "InputTimeLimitExceeded", "NoMatchingError"]),
      Conditions: Object.entries(keys).map(([key, target]) => ({
        NextAction: target,
        Condition: { Operator: "Equals", Operands: [key] },
      })),
    },
  );

/** Collect digits ended by #. The answer is in $.StoredCustomerInput until the next input block. */
const digits = (id, text, max, next, err) =>
  add(
    id,
    "GetParticipantInput",
    {
      StoreInput: "True",
      InputTimeLimitSeconds: "12",
      Text: text,
      DTMFConfiguration: { DisableCancelKey: "False", InputTerminationSequence: "#" },
      InputValidation: { CustomValidation: { MaximumLength: String(max) } },
    },
    // Connect refuses InputTimeLimitExceeded when the input is stored (probe, 30 Oct 2026).
    { NextAction: next, Errors: errs(err, ["NoMatchingError"]), Conditions: [] },
  );

const invoke = (id, attributes, next, err) =>
  add(
    id,
    "InvokeLambdaFunction",
    {
      LambdaFunctionARN: "${lambda_arn}",
      InvocationTimeLimitSeconds: "8",
      LambdaInvocationAttributes: attributes,
      ResponseValidation: { ResponseType: "STRING_MAP" },
    },
    { NextAction: next, Errors: errs(err), Conditions: [] },
  );

/** Branch on a value. `cases` maps each value to a block; anything else goes to `otherwise`. */
const compare = (id, value, cases, otherwise) =>
  add(
    id,
    "Compare",
    { ComparisonValue: value },
    {
      NextAction: otherwise,
      // Connect refuses NoMatchingError on a Compare block (real answer, 30 Oct 2026),
      // so only NoMatchingCondition is routed here.
      Errors: errs(otherwise, ["NoMatchingCondition"]),
      Conditions: Object.entries(cases).map(([val, target]) => ({
        NextAction: target,
        Condition: { Operator: "Equals", Operands: [val] },
      })),
    },
  );

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

logging("S01-SetLogging", "S02-SetVoice");
voice("S02-SetVoice", "S03-Identify");

// Quietly work out whether the caller's number belongs to a known user. Nothing
// is spoken from the answer: a caller ID can be faked, so the NAME is for the
// agent's screen only. If the lookup fails, carry on as an unknown caller.
invoke("S03-Identify", { action: "identify" }, "S04-SetCallerAttributes", "S05-Welcome");
setAttrs(
  "S04-SetCallerAttributes",
  { callerKnown: "$.External.callerKnown", callerMatch: "$.External.callerMatch", callerVerified: "false" },
  "S05-Welcome",
);
say("S05-Welcome", "Welcome to the lab service desk.", "M01-MainMenu");

menu(
  "M01-MainMenu",
  "To report a problem, press 1. To ask for something, press 2. To check on a ticket, press 3. To speak to an agent, press 0.",
  { 1: "I01-ProblemType", 2: "R01-CheckKnown", 3: "T01-CheckKnown", 0: "Q01-SayAgent" },
  "Q01-SayAgent",
);

// ---- 1. report a problem (an incident). No verification: anyone may report one. ----
menu(
  "I01-ProblemType",
  "What kind of problem is it? For software or an app, press 1. For the network or your connection, press 2. For anything else, press 3.",
  { 1: "I02-Cat1", 2: "I02-Cat2", 3: "I02-Cat3" },
  "I02-Cat3",
);
setAttrs("I02-Cat1", { issueCategory: "1" }, "I03-Urgency");
setAttrs("I02-Cat2", { issueCategory: "2" }, "I03-Urgency");
setAttrs("I02-Cat3", { issueCategory: "3" }, "I03-Urgency");
menu(
  "I03-Urgency",
  "Does this stop you from working? Press 1 for yes. Press 2 for no.",
  { 1: "I04-Urgent", 2: "I04-NotUrgent" },
  "I04-NotUrgent",
);
setAttrs("I04-Urgent", { urgent: "1" }, "I05-Create");
setAttrs("I04-NotUrgent", { urgent: "2" }, "I05-Create");
invoke(
  "I05-Create",
  { action: "create_incident", category: "$.Attributes.issueCategory", urgent: "$.Attributes.urgent" },
  "I06-CheckCreated",
  "N01-SayNotLogged",
);
compare("I06-CheckCreated", "$.External.status", { created: "I07-SetTicket", existing: "I07-SetTicket" }, "N01-SayNotLogged");
setAttrs(
  "I07-SetTicket",
  {
    ticketType: "$.External.ticketType",
    ticketNumber: "$.External.ticketNumber",
    ticketSpoken: "$.External.ticketSpoken",
    agentSummary: "$.External.agentSummary",
  },
  "I08-SayTicket",
);
say(
  "I08-SayTicket",
  "I have logged your problem. Your reference number is $.Attributes.ticketSpoken. I will say that again. $.Attributes.ticketSpoken. Connecting you to an agent now.",
  "Q10-SetQueue",
);
say("N01-SayNotLogged", "Sorry, I could not log that automatically, but an agent will still help you. Connecting you now.", "Q10-SetQueue");

// ---- 2. ask for something (a service request). Known, verified callers only. ----
compare("R01-CheckKnown", "$.Attributes.callerKnown", { true: "R02-RequestType" }, "X01-SayNotRecognised");
menu(
  "R02-RequestType",
  "What do you need? For access to a system, press 1. For equipment, press 2. For general information, press 3.",
  { 1: "R03-Type1", 2: "R03-Type2", 3: "R03-Type3" },
  "Q01-SayAgent",
);
setAttrs("R03-Type1", { requestType: "1" }, "R04-AskDigits");
setAttrs("R03-Type2", { requestType: "2" }, "R04-AskDigits");
setAttrs("R03-Type3", { requestType: "3" }, "R04-AskDigits");
const ASK_DIGITS =
  "For your security, please enter the last four digits of your customer number, then press hash.";
digits("R04-AskDigits", ASK_DIGITS, 4, "R05-Create", "V01-SayCouldNotVerify");
invoke(
  "R05-Create",
  { action: "create_request", requestType: "$.Attributes.requestType", digits: "$.StoredCustomerInput" },
  "R06-CheckCreated",
  "N02-SayRequestNotLogged",
);
compare(
  "R06-CheckCreated",
  "$.External.status",
  {
    created: "R10-SetTicket",
    existing: "R10-SetTicket",
    verification_failed: "R07-SayTryAgain",
    not_recognised: "X01-SayNotRecognised",
  },
  "N02-SayRequestNotLogged",
);
say("R07-SayTryAgain", "Sorry, those digits did not match. Let us try once more.", "R08-AskDigitsAgain");
digits("R08-AskDigitsAgain", ASK_DIGITS, 4, "R09-CreateAgain", "V01-SayCouldNotVerify");
invoke(
  "R09-CreateAgain",
  { action: "create_request", requestType: "$.Attributes.requestType", digits: "$.StoredCustomerInput" },
  "R09b-CheckCreatedAgain",
  "N02-SayRequestNotLogged",
);
compare(
  "R09b-CheckCreatedAgain",
  "$.External.status",
  { created: "R10-SetTicket", existing: "R10-SetTicket", not_recognised: "X01-SayNotRecognised", verification_failed: "V01-SayCouldNotVerify" },
  "N02-SayRequestNotLogged",
);
setAttrs(
  "R10-SetTicket",
  {
    callerVerified: "true",
    ticketType: "$.External.ticketType",
    ticketNumber: "$.External.ticketNumber",
    ticketSpoken: "$.External.ticketSpoken",
    agentSummary: "$.External.agentSummary",
  },
  "R11-SayTicket",
);
say(
  "R11-SayTicket",
  "Thank you. You are verified. I have logged your request. Your reference number is $.Attributes.ticketSpoken. I will say that again. $.Attributes.ticketSpoken. Connecting you to an agent now.",
  "Q10-SetQueue",
);
say("N02-SayRequestNotLogged", "Sorry, I could not log your request automatically, but an agent will help you. Connecting you now.", "Q10-SetQueue");

// ---- 3. check on a ticket. Known, verified callers; their own tickets only. ----
compare("T01-CheckKnown", "$.Attributes.callerKnown", { true: "T02-Kind" }, "X01-SayNotRecognised");
menu(
  "T02-Kind",
  "To check an incident, press 1. To check a request, press 2.",
  { 1: "T03-Kind1", 2: "T03-Kind2" },
  "Q01-SayAgent",
);
setAttrs("T03-Kind1", { ticketKind: "1" }, "T04-AskNumber");
setAttrs("T03-Kind2", { ticketKind: "2" }, "T04-AskNumber");
digits(
  "T04-AskNumber",
  "Please enter the seven digit ticket number, then press hash. You do not need to enter the letters.",
  7,
  "T05-KeepNumber",
  "T30-SayCouldNotCheck",
);
// The ticket number is not secret, so it may sit on the contact while the caller
// is asked for the digits that ARE secret (those are never stored).
setAttrs("T05-KeepNumber", { ticketDigits: "$.StoredCustomerInput" }, "T06-AskDigits");
digits("T06-AskDigits", ASK_DIGITS, 4, "T07-Check", "V01-SayCouldNotVerify");
invoke(
  "T07-Check",
  { action: "status", kind: "$.Attributes.ticketKind", number: "$.Attributes.ticketDigits", digits: "$.StoredCustomerInput" },
  "T08-CheckFound",
  "T30-SayCouldNotCheck",
);
compare(
  "T08-CheckFound",
  "$.External.status",
  { found: "T20-SetStatus", verification_failed: "T10-SayTryAgain", not_recognised: "X01-SayNotRecognised" },
  "T30-SayCouldNotCheck",
);
say("T10-SayTryAgain", "Sorry, those digits did not match. Let us try once more.", "T11-AskDigitsAgain");
digits("T11-AskDigitsAgain", ASK_DIGITS, 4, "T12-CheckAgain", "V01-SayCouldNotVerify");
invoke(
  "T12-CheckAgain",
  { action: "status", kind: "$.Attributes.ticketKind", number: "$.Attributes.ticketDigits", digits: "$.StoredCustomerInput" },
  "T13-CheckFoundAgain",
  "T30-SayCouldNotCheck",
);
compare(
  "T13-CheckFoundAgain",
  "$.External.status",
  { found: "T20-SetStatus", not_recognised: "X01-SayNotRecognised", verification_failed: "V01-SayCouldNotVerify" },
  "T30-SayCouldNotCheck",
);
setAttrs(
  "T20-SetStatus",
  { callerVerified: "true", ticketSpoken: "$.External.ticketSpoken", statusText: "$.External.statusText" },
  "T21-SayStatus",
);
say("T21-SayStatus", "Ticket $.Attributes.ticketSpoken is currently $.Attributes.statusText. Thank you for calling. Goodbye.", "Z01-Disconnect");
say("T30-SayCouldNotCheck", "Sorry, I could not find or check that ticket for you. I will connect you to an agent.", "Q10-SetQueue");

// ---- shared messages ----
say("X01-SayNotRecognised", "Sorry, I can only do that for callers I recognise. I will connect you to an agent.", "Q10-SetQueue");
say("V01-SayCouldNotVerify", "Sorry, I could not verify you. I will connect you to an agent.", "Q10-SetQueue");

// ---- the queue, shared by every path that ends with an agent ----
say("Q01-SayAgent", "Connecting you to an agent.", "Q10-SetQueue");
add("Q10-SetQueue", "UpdateContactTargetQueue", { QueueId: "${queue_arn}" }, {
  NextAction: "Q11-Transfer",
  Errors: errs("Q14-TransferFailed"),
  Conditions: [],
});
add("Q11-Transfer", "TransferContactToQueue", {}, {
  NextAction: "Q12-EndFlow",
  Errors: [
    { NextAction: "Q13-AtCapacity", ErrorType: "QueueAtCapacity" },
    { NextAction: "Q14-TransferFailed", ErrorType: "NoMatchingError" },
  ],
  Conditions: [],
});
add("Q12-EndFlow", "EndFlowExecution", {}, {});
say("Q13-AtCapacity", "Sorry, all our agents are busy and the queue is full. Please try again shortly.", "Z01-Disconnect");
say("Q14-TransferFailed", "Sorry, we cannot connect your call right now. Please try again later.", "Z01-Disconnect");
add("Z01-Disconnect", "DisconnectParticipant", {}, {});

// ---------------------------------------------------------------------------
// Layout (cosmetic: where the blocks sit on the designer canvas) and output
// ---------------------------------------------------------------------------

const COLUMN = { S: 0, M: 0, I: 1, R: 2, T: 3, N: 1, X: 4, V: 4, Q: 4, Z: 4 };
const rowsUsed = {};
const metadata = {};
for (const b of blocks) {
  const col = COLUMN[b.Identifier[0]] ?? 4;
  const row = (rowsUsed[col] = (rowsUsed[col] ?? -1) + 1);
  metadata[b.Identifier] = { position: { x: 160 + col * 300, y: 20 + row * 140 } };
}

const flow = {
  Version: "2019-10-30",
  StartAction: blocks[0].Identifier,
  Metadata: { entryPointPosition: { x: 20, y: 20 }, ActionMetadata: metadata },
  Actions: blocks.map((b) => ({
    ...b,
    // Terminal blocks have no transitions at all, as Connect writes them.
    Transitions: b.Transitions.NextAction === undefined && !("Errors" in b.Transitions) ? {} : b.Transitions,
  })),
};

const text = `${JSON.stringify(flow, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const onDisk = readFileSync(OUT, "utf8");
  if (onDisk !== text) {
    console.error("terraform/flows/servicedesk.json.tftpl is out of date. Run: node tools/gen-flow.mjs");
    process.exit(1);
  }
  console.log(`flow template is up to date (${blocks.length} blocks)`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT} (${blocks.length} blocks)`);
}
