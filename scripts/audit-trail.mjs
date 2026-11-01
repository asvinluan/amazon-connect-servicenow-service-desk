// Print the audit trail the deployed Lambda wrote, newest last. READ-ONLY.
//
// Use it after each test call to see what the function decided:
//   caller_identified / verification_passed / incident_created / call_ended_note /
//   lens_ticket_created / lens_note, plus a "lens event received" line that
//   records which event name Amazon Connect really sent.
//
//   node scripts/audit-trail.mjs                  last 30 minutes
//   node scripts/audit-trail.mjs --minutes 120
//   node scripts/audit-trail.mjs --contact <contact id>
//
// Run by audit-trail.ps1 or audit-trail.sh.
import { execFileSync } from "node:child_process";

const region = process.env.AWS_REGION || "ap-southeast-2";
const args = process.argv.slice(2);
const opt = (name, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const minutes = Number(opt("minutes", "30")) || 30;
const contact = opt("contact");

function logGroup() {
  const fromEnv = (process.env.LOG_GROUP || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("terraform", ["output", "-raw", "log_group"], {
      cwd: new URL("../terraform/", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    console.error("STOPPED: could not read the log group from Terraform. Has the apply finished?");
    console.error("         Or set LOG_GROUP to /aws/lambda/<your function name> and run again.");
    process.exit(1);
  }
}

const group = logGroup();
const start = Date.now() - minutes * 60_000;
let out;
try {
  out = execFileSync(
    "aws",
    ["logs", "filter-log-events", "--log-group-name", group, "--region", region, "--start-time", String(start), "--output", "json"],
    { encoding: "utf8", env: { ...process.env, AWS_PAGER: "" }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
} catch (err) {
  console.error("STOPPED: could not read the log group. " + String(err.stderr || err.message).split("\n")[0]);
  process.exit(1);
}

const rows = [];
for (const e of JSON.parse(out).events ?? []) {
  let m;
  try {
    m = JSON.parse(e.message);
  } catch {
    continue; // not a JSON log line
  }
  const isAudit = m.audit === true;
  const isLensSeen = m.message === "lens event received";
  if (!isAudit && !isLensSeen) continue;
  if (contact && m.contactId !== contact) continue;
  rows.push({
    time: new Date(e.timestamp).toISOString().slice(11, 19),
    what: isAudit ? m.auditEvent : "lens event received",
    contact: String(m.contactId || "").slice(0, 8),
    ticket: m.ticketNumber || "",
    note: isAudit ? m.reason || "" : `${m.detailType} / ${m.ruleName}`,
  });
}

console.log(`Audit trail from ${group} (last ${minutes} min${contact ? `, contact ${contact}` : ""}):\n`);
if (!rows.length) {
  console.log("  Nothing yet. Wait a minute after the call ends, then run this again.");
} else {
  console.log("TIME      EVENT                  CONTACT   TICKET      NOTE");
  for (const r of rows) console.log(`${r.time}  ${r.what.padEnd(21)}  ${r.contact.padEnd(8)}  ${r.ticket.padEnd(10)}  ${r.note}`);
}
