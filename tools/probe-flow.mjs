#!/usr/bin/env node
// Asks Amazon Connect WHY it refused the flow, which Terraform hides.
// It renders the same flow Terraform uses and sends it with the AWS CLI under a
// throw-away name. It prints only the "Problems" part of the answer (no keys).
// If Connect accepts it, the probe flow is deleted again.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const AWS = process.env.AWS_BIN || "aws";
const awsCmd = AWS.startsWith("node:") ? ["node", [AWS.slice(5)]] : [AWS, []];
const region = process.env.AWS_REGION || "ap-southeast-2";

function aws(args, opts = {}) {
  return spawnSync(awsCmd[0], [...awsCmd[1], ...args, "--region", region], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts,
  });
}
function redact(t) { return t.replace(/AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|Credential=\S+|Signature=\S+|X-Amz-\S+/g, "[removed]"); }
function stop(msg) { console.error("STOPPED: " + msg); process.exit(1); }

const tfvars = readFileSync(join(root, "terraform", "terraform.tfvars"), "utf8");
const get = (k, d) => {
  const m = tfvars.match(new RegExp("^\\s*" + k + "\\s*=\\s*\"([^\"]*)\"", "m"));
  return m ? m[1] : d;
};
const instanceId = get("connect_instance_id", "");
const queueName = get("queue_name", "");
const prefix = get("name_prefix", "lab-sd");
if (!/^[0-9a-f-]{36}$/.test(instanceId)) stop("connect_instance_id in terraform.tfvars is not a 36-character id in quotes.");

const fn = aws(["lambda", "get-function-configuration", "--function-name", prefix + "-servicedesk",
  "--query", "FunctionArn", "--output", "text"]);
if (fn.status !== 0) stop("could not read the Lambda " + prefix + "-servicedesk. Did terraform apply create it?");
const lambdaArn = fn.stdout.trim();

const qs = aws(["connect", "list-queues", "--instance-id", instanceId, "--output", "json"]);
if (qs.status !== 0) stop("could not list queues on that instance.");
const queue = (JSON.parse(qs.stdout).QueueSummaryList || []).find((q) => q.Name === queueName);
if (!queue) stop("queue '" + queueName + "' not found on that instance.");

let content = readFileSync(join(root, "terraform", "flows", "servicedesk.json.tftpl"), "utf8");
content = content.split("${lambda_arn}").join(lambdaArn).split("${queue_arn}").join(queue.Arn);
JSON.parse(content); // fails loudly if the JSON itself is broken

const dir = mkdtempSync(join(tmpdir(), "probe-"));
const file = join(dir, "flow.json");
writeFileSync(file, content);
const name = "lab-sd-probe-" + Date.now();
console.log("Sending the flow to Connect under the name " + name + " ...");
const r = aws(["connect", "create-contact-flow", "--instance-id", instanceId, "--name", name,
  "--type", "CONTACT_FLOW", "--content", "file://" + file, "--debug"]);
rmSync(dir, { recursive: true, force: true });

const text = (r.stderr || "") + (r.stdout || "");
if (r.status === 0) {
  const idm = text.match(/"ContactFlowId"\s*:\s*"([^"]+)"/);
  console.log("Connect ACCEPTED the flow. So the flow JSON is fine and the problem is in Terraform.");
  if (idm) {
    const d = aws(["connect", "delete-contact-flow", "--instance-id", instanceId, "--contact-flow-id", idm[1]]);
    console.log(d.status === 0 ? "The probe flow was deleted again."
      : "Delete the flow named " + name + " in the Connect console (Routing > Flows).");
  }
  process.exit(0);
}
const i = text.search(/"problems"/i);
const j = text.indexOf("InvalidContactFlowException");
if (i >= 0) {
  const after = text.slice(i, i + 20000);
  const msgs = [...new Set([...after.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/gi)].map((m) => m[1]))];
  console.log("\nConnect refused the flow. Its list of problems:\n");
  if (msgs.length) msgs.forEach((m, n) => console.log((n + 1) + ". " + redact(m)));
  else console.log(redact(after.slice(0, 2500)));
} else if (j >= 0) {
  console.log("\nConnect refused the flow but gave no problem list:\n");
  console.log(redact(text.slice(j, j + 600)));
} else {
  console.log("\nThe call failed for another reason (last lines, no keys):\n");
  console.log((r.stderr || "").split("\n").filter((l) => /error|denied|invalid/i.test(l) && !/authorization|signature|credential/i.test(l)).slice(-6).join("\n"));
}
process.exit(2);
