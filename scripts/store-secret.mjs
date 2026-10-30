// Check a ServiceNow sign-in, then store it in AWS Secrets Manager.
//
// Run by store-secret.ps1 or store-secret.sh, which ask for the values and pass
// them in through environment variables (never on the command line, never in a
// file). This script:
//
//   1. proves the sign-in works, with READ-ONLY calls to ServiceNow, and shows
//      what the integration user is allowed to read;
//   2. only if it works, writes the secret named SECRET_NAME to AWS Secrets Manager.
//
// Two ways to sign in (SN_AUTH):
//   oauth  OAuth 2.0 client credentials: SN_CLIENT_ID and SN_CLIENT_SECRET.
//          This is the design to copy. Nothing stores a user's password.
//   basic  A user name and password: SN_USER and SN_PASS. The fallback for an
//          instance where the client-credentials grant is not switched on.
//
// Secrets are never printed. Customer numbers are never printed either: the
// check only COUNTS how many users have one.
//
// Why Node and not the AWS CLI: the AWS CLI takes the secret text as one
// command-line argument, and Windows PowerShell 5.1 mangles the double quotes in
// JSON passed that way. Doing it here means identical behaviour in PowerShell,
// Git Bash, MSYS2 and WSL.
import { createRequire } from "node:module";

// The AWS SDK is installed by `npm ci` in the Lambda folder (a dev dependency).
const require = createRequire(new URL("../lambda/servicedesk/package.json", import.meta.url));

const env = (name, fallback = "") => (process.env[name] ?? fallback).trim();

// Accept "devNNNNNN", "devNNNNNN.service-now.com" or a pasted address.
const instance = env("SN_INSTANCE")
  .replace(/^https?:\/\//i, "")
  .replace(/\.service-now\.com.*$/i, "")
  .replace(/\/+$/, "");
const mode = env("SN_AUTH", "oauth").toLowerCase();
const username = env("SN_USER");
const password = process.env.SN_PASS ?? "";
const clientId = env("SN_CLIENT_ID");
const clientSecret = process.env.SN_CLIENT_SECRET ?? "";
const secretName = env("SECRET_NAME", "lab/servicedesk");
const region = env("AWS_REGION", "ap-southeast-2");

function stop(code, message) {
  console.error(`\nSTOPPED: ${message}`);
  process.exit(code);
}

if (!/^[a-z0-9][a-z0-9-]{1,40}$/i.test(instance)) {
  stop(1, "the instance name should be only the part before .service-now.com, for example devNNNNNN.");
}
if (mode !== "oauth" && mode !== "basic") stop(1, "SN_AUTH must be oauth or basic.");
if (mode === "basic" && (!username || !password)) stop(1, "the user name and the password are both required.");
if (mode === "oauth" && (!clientId || !clientSecret)) stop(1, "the client ID and the client secret are both required.");

const baseUrl = `https://${instance.toLowerCase()}.service-now.com`;

async function request(url, init) {
  try {
    const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      /* not JSON: a sleeping instance answers with a web page */
    }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: err instanceof Error ? err.name : "unknown" };
  }
}

const SLEEPING =
  "could not get an answer from ServiceNow. A developer instance goes to sleep when it is idle: " +
  "sign in at developer.servicenow.com, wake the instance, wait a few minutes and try again. " +
  "Also check the instance name for typos.";

// ---- sign in ---------------------------------------------------------------
console.log(`Checking the sign-in at ${baseUrl} (${mode}, read-only calls)...`);

let authorization;
if (mode === "basic") {
  authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
} else {
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();
  const token = await request(`${baseUrl}/oauth_token.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form,
  });
  if (token.status === 0 || (token.status === 200 && token.json === null)) stop(3, SLEEPING);
  if (token.status === 400 || token.status === 401) {
    stop(
      2,
      "ServiceNow refused the client ID and secret, or the client-credentials grant is not switched on for this " +
        "instance. Check both (the manual, section 5, says where). If it is the grant, rerun this and choose " +
        "basic instead. Nothing was stored.",
    );
  }
  if (token.status !== 200 || typeof token.json?.access_token !== "string") {
    stop(3, `the token request got an unexpected answer (status ${token.status}).`);
  }
  console.log("  OAuth token         : received");
  authorization = `Bearer ${token.json.access_token}`;
}

const get = (path) => request(`${baseUrl}${path}`, { headers: { Authorization: authorization, Accept: "application/json" } });

// ---- what can it read? -----------------------------------------------------
const incidents = await get("/api/now/table/incident?sysparm_limit=1&sysparm_fields=sys_id");
if (incidents.status === 0 || (incidents.status === 200 && incidents.json === null)) stop(3, SLEEPING);
if (incidents.status === 401) stop(2, "ServiceNow rejected the sign-in. Nothing was stored.");
if (incidents.status === 403) {
  stop(2, "the sign-in works but this user may not read incidents. Give the user the itil role, then try again.");
}
if (incidents.status !== 200) stop(3, `ServiceNow answered with an unexpected status (${incidents.status}).`);
console.log("  can read incidents  : yes");

const requests = await get("/api/now/table/sc_request?sysparm_limit=1&sysparm_fields=sys_id");
if (requests.status === 200 && requests.json !== null) {
  console.log("  can read requests   : yes");
} else {
  console.log(
    `  can read requests   : NO (status ${requests.status}). Requests will fail until the user also has the ` +
      "sn_request_write role (the manual, section 4).",
  );
}

const users = await get("/api/now/table/sys_user?sysparm_limit=20&sysparm_fields=sys_id,employee_number&sysparm_query=active%3Dtrue");
if (users.status === 200 && Array.isArray(users.json?.result)) {
  const rows = users.json.result;
  const withNumber = rows.filter((r) => typeof r.employee_number === "string" && r.employee_number.length >= 4).length;
  console.log(`  can read users      : yes (${rows.length} checked)`);
  console.log(
    withNumber > 0
      ? `  customer numbers    : readable on ${withNumber} of ${rows.length} (caller verification needs this; values are not shown)`
      : "  customer numbers    : NONE readable. Caller verification will refuse everybody until the Employee ID field " +
          "is filled in on the test users, and readable by this user (the manual, section 4).",
  );
} else {
  console.log(
    `  can read users      : NO (status ${users.status}). Callers will not be recognised, so requests and ` +
      "status checks will be refused.",
  );
}

// ---- store -----------------------------------------------------------------
console.log(`\nStoring the sign-in in AWS Secrets Manager as "${secretName}" (${region})...`);
const { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } = require("@aws-sdk/client-secrets-manager");
const client = new SecretsManagerClient({ region });
const secretString = JSON.stringify(
  mode === "oauth"
    ? { instance_url: baseUrl, auth: "oauth", client_id: clientId, client_secret: clientSecret }
    : { instance_url: baseUrl, auth: "basic", username, password },
);

try {
  try {
    await client.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: secretString }));
    console.log("  updated the existing secret");
  } catch (err) {
    if (err?.name !== "ResourceNotFoundException") throw err;
    await client.send(
      new CreateSecretCommand({
        Name: secretName,
        SecretString: secretString,
        Description: "ServiceNow sign-in for the Amazon Connect service desk lab. Created by scripts/store-secret.",
      }),
    );
    console.log("  created a new secret");
  }
} catch (err) {
  const name = err instanceof Error ? err.name : "unknown";
  if (name === "AccessDeniedException") {
    stop(4, "your AWS login is not allowed to write secrets in this account.");
  }
  if (name === "CredentialsProviderError" || /credential/i.test(name)) {
    stop(4, "no AWS login found. Run: aws configure   (or aws sso login) and try again.");
  }
  stop(4, `AWS refused the request (${name}). Check the account and region with: aws sts get-caller-identity`);
}

console.log("\nDone. Nothing secret was printed and nothing is saved in any file.");
console.log("Next: plan.");
