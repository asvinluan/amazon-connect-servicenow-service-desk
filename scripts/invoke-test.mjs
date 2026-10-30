// Try the DEPLOYED service desk Lambda with synthetic events and print a table.
//
// Run by invoke-test.ps1 or invoke-test.sh. It calls the AWS CLI directly (with an
// argument list, so no shell can mangle the JSON) and checks each answer against
// what it should be. No password is involved: the function reads its own secret.
//
// It creates REAL tickets in your ServiceNow developer instance (one incident and
// one request per run, because the contact ids are new each time). They are
// fictional and safe to delete.
//
// Needs the two test users from the manual (section 4):
//   Test Caller Lab   mobile +61355500101   Employee ID 48201357  (last 4 = 1357)
//   Other Caller Lab  mobile +61355500102   Employee ID 99990000  (optional)
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const region = process.env.AWS_REGION || "ap-southeast-2";
const repoTerraform = new URL("../terraform/", import.meta.url);

function functionName() {
  const fromEnv = (process.env.FUNCTION_NAME || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("terraform", ["output", "-raw", "function_name"], {
      cwd: repoTerraform,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    console.error("STOPPED: could not read the function name from Terraform. Has the apply finished?");
    console.error("         Or set FUNCTION_NAME to the function's name and run again.");
    process.exit(1);
  }
}

const fn = functionName();
const work = mkdtempSync(join(tmpdir(), "sd-test-"));

function invoke(event) {
  const outFile = join(work, `out-${randomUUID()}.json`);
  const functionError = execFileSync(
    "aws",
    [
      "lambda", "invoke",
      "--function-name", fn,
      "--region", region,
      "--cli-binary-format", "raw-in-base64-out",
      "--payload", JSON.stringify(event),
      "--query", "FunctionError",
      "--output", "text",
      outFile,
    ],
    { encoding: "utf8", env: { ...process.env, AWS_PAGER: "" }, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  const body = readFileSync(outFile, "utf8");
  if (functionError && functionError !== "None") return { crashed: true, body };
  return JSON.parse(body);
}

const flowEvent = (action, extra, contactId, caller) => ({
  Details: {
    Parameters: { action, ...extra },
    ContactData: { ContactId: contactId, CustomerEndpoint: { Address: caller } },
  },
});

const disconnectEvent = (contactId) => ({
  "detail-type": "Amazon Connect Contact Event",
  source: "aws.connect",
  detail: {
    eventType: "DISCONNECTED",
    channel: "VOICE",
    contactId,
    initiationTimestamp: new Date(Date.now() - 95_000).toISOString(),
    disconnectTimestamp: new Date().toISOString(),
    agentInfo: { connectedToAgentTimestamp: new Date(Date.now() - 75_000).toISOString() },
  },
});

const KNOWN = "+61355500101";
const OTHER = "+61355500102";
const UNKNOWN = "+61355500999";
const RIGHT = "1357";
const WRONG = "1358";

const rows = [];
let hardFail = 0;
const ctx = {};

function check(name, run, verify) {
  let result;
  try {
    result = run();
  } catch (err) {
    result = { crashed: true, body: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
  const verdict = result.crashed ? "FAIL" : verify(result);
  if (verdict === "FAIL") hardFail += 1;
  rows.push({ name, status: result.status ?? "(crashed)", detail: result.reason || "", verdict });
  if (result.crashed) console.error(`  ${name}: ${String(result.body).slice(0, 300)}`);
  return result;
}

const contactInc = randomUUID();
const contactReq = randomUUID();
const contactNone = randomUUID();
const digitsOf = (n) => (n || "").replace(/\D/g, "");

console.log(`Function : ${fn}  (${region})`);
console.log("This creates fictional tickets in your ServiceNow developer instance.\n");

// ---- identify (no verification yet: the name must never come back to the flow's voice)
check("1 identify, known caller", () => invoke(flowEvent("identify", {}, randomUUID(), KNOWN)), (r) =>
  r.status === "identified" && r.callerKnown === "true" ? "PASS" : "FAIL");
check("2 identify, unknown caller", () => invoke(flowEvent("identify", {}, randomUUID(), UNKNOWN)), (r) =>
  r.status === "unknown" && r.callerKnown === "false" ? "PASS" : "FAIL");

// ---- incidents (no verification needed to REPORT a problem)
ctx.inc = check("3 create incident", () => invoke(flowEvent("create_incident", { category: "2", urgent: "1" }, contactInc, KNOWN)), (r) =>
  r.status === "created" && /^INC\d{7}$/.test(r.ticketNumber) ? "PASS" : "FAIL");
check("4 create incident again, same call", () => invoke(flowEvent("create_incident", { category: "2" }, contactInc, KNOWN)), (r) =>
  r.status === "existing" && r.ticketNumber === ctx.inc?.ticketNumber ? "PASS" : "FAIL");
check("5 create incident, unknown caller", () => invoke(flowEvent("create_incident", { category: "1" }, randomUUID(), UNKNOWN)), (r) =>
  r.status === "created" ? "PASS" : "FAIL");

// ---- requests (verification required)
ctx.req = check("6 create request, right digits", () => invoke(flowEvent("create_request", { requestType: "2", digits: RIGHT }, contactReq, KNOWN)), (r) =>
  r.status === "created" && /^REQ\d{7}$/.test(r.ticketNumber) ? "PASS" : "FAIL");
check("7 create request again, same call", () => invoke(flowEvent("create_request", { requestType: "2", digits: RIGHT }, contactReq, KNOWN)), (r) =>
  r.status === "existing" && r.ticketNumber === ctx.req?.ticketNumber ? "PASS" : "FAIL");
check("8 create request, wrong digits", () => invoke(flowEvent("create_request", { requestType: "1", digits: WRONG }, randomUUID(), KNOWN)), (r) =>
  r.status === "verification_failed" && r.ticketNumber === "" ? "PASS" : "FAIL");
check("9 create request, unknown caller", () => invoke(flowEvent("create_request", { requestType: "1", digits: RIGHT }, randomUUID(), UNKNOWN)), (r) =>
  r.status === "not_recognised" && r.ticketNumber === "" ? "PASS" : "FAIL");

// ---- status (verification, then ownership)
const incDigits = digitsOf(ctx.inc?.ticketNumber);
const reqDigits = digitsOf(ctx.req?.ticketNumber);
check("10 status of own incident", () => invoke(flowEvent("status", { kind: "1", number: incDigits, digits: RIGHT }, randomUUID(), KNOWN)), (r) =>
  r.status === "found" && !!r.statusText ? "PASS" : "FAIL");
check("11 status of own request", () => invoke(flowEvent("status", { kind: "2", number: reqDigits, digits: RIGHT }, randomUUID(), KNOWN)), (r) =>
  r.status === "found" && !!r.statusText ? "PASS" : "FAIL");
check("12 status, wrong digits", () => invoke(flowEvent("status", { kind: "1", number: incDigits, digits: WRONG }, randomUUID(), KNOWN)), (r) =>
  r.status === "verification_failed" && r.statusText === "" ? "PASS" : "FAIL");

// 13 and 14 must give the SAME answer: a ticket that is not yours must look
// exactly like a ticket that does not exist.
const notYours = check("13 status of someone else's ticket", () => invoke(flowEvent("status", { kind: "1", number: incDigits, digits: "9999" }, randomUUID(), OTHER)), (r) =>
  r.status === "not_found" || r.status === "verification_failed" || r.status === "not_recognised" ? "PASS" : "FAIL");
const missing = check("14 status of a ticket that does not exist", () => invoke(flowEvent("status", { kind: "1", number: "0099999", digits: RIGHT }, randomUUID(), KNOWN)), (r) =>
  r.status === "not_found" ? "PASS" : "FAIL");
void notYours;
void missing;

// ---- call ended
check("15 call ended -> work note on the ticket", () => invoke(disconnectEvent(contactInc)), (r) =>
  r.status === "updated" ? "PASS" : "FAIL");
check("16 call ended, but no ticket for it", () => invoke(disconnectEvent(randomUUID())), (r) =>
  r.status === "no_ticket" ? "PASS" : "FAIL");

rmSync(work, { recursive: true, force: true });

const w = Math.max(...rows.map((r) => r.name.length));
console.log("Test".padEnd(w), " ", "Status".padEnd(20), "Detail".padEnd(24), "Result");
for (const r of rows) {
  console.log(r.name.padEnd(w), " ", String(r.status).padEnd(20), String(r.detail).padEnd(24), r.verdict);
}
console.log(
  hardFail === 0
    ? `\nAll checks passed. Look for ${ctx.inc?.ticketNumber || "the incident"} (Incident > All) and ${ctx.req?.ticketNumber || "the request"} (Service Catalog > Requests) in ServiceNow.`
    : `\n${hardFail} check(s) FAILED. Open the function's log in CloudWatch (log group /aws/lambda/${fn}) and read the reason field.`,
);
console.log("Checks 13 and 14 test the 'not yours looks like not found' rule: compare their answers by eye in the CloudWatch audit view.");
process.exit(hardFail === 0 ? 0 : 1);
