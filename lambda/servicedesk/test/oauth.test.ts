// OAuth 2.0 client-credentials sign-in, and the choice between it and basic auth.
//
// What these pin down:
//   * a token is fetched once and reused, across calls and across warm invocations;
//   * a 401 gets exactly one fresh token and one retry, not a loop;
//   * every way the token call can fail becomes a usable answer, never a throw;
//   * neither the client secret nor the token ever reaches a log or a response;
//   * secrets are only ever sent to a ServiceNow host.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "../src/handler";
import {
  BASIC,
  CLIENT_ID,
  CLIENT_SECRET,
  FakeServiceNow,
  INSTANCE,
  PASSWORD,
  SECRET_OAUTH,
  USERNAME,
  captureConsole,
  flowEvent,
  install,
  jsonResponse,
} from "./helpers";

let fake: FakeServiceNow;

function useOauth(secret = SECRET_OAUTH) {
  ({ fake } = install(secret));
  fake.requireBearer = true;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const identify = () => handler(flowEvent({ action: "identify" }));
const tableCalls = () => fake.calls.filter((c) => c.path.startsWith("/api/now/table"));

describe("oauth: getting and using a token", () => {
  beforeEach(() => useOauth());

  it("fetches a token with the client-credentials grant and sends it as a Bearer header", async () => {
    fake.addUser();
    const result = await identify();

    expect(result.status).toBe("identified");
    const tokenCall = fake.callsTo("POST", "/oauth_token.do")[0];
    expect(tokenCall?.rawUrl).toBe(`${INSTANCE}/oauth_token.do`);
    expect(tokenCall?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(tokenCall?.rawBody);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(tableCalls()[0]?.headers.Authorization).toBe("Bearer token-1");
  });

  it("does not put the client secret or the token in a URL", async () => {
    fake.addUser();
    await identify();
    for (const c of fake.calls) {
      expect(c.rawUrl).not.toContain(CLIENT_SECRET);
      expect(c.rawUrl).not.toContain("token-1");
    }
  });

  it("reuses the token for every call in an invocation and across warm invocations", async () => {
    fake.addUser();
    await handler(flowEvent({ action: "create_incident" }));
    await identify();
    await identify();
    expect(fake.tokensIssued).toBe(1);
    expect(fake.callsTo("POST", "/oauth_token.do")).toHaveLength(1);
  });

  it("fetches a new token once the old one is about to expire", async () => {
    // 30 seconds of life is inside the 60-second safety margin: already stale.
    fake.tokenExpiresIn = 30;
    fake.addUser();
    await identify();
    await identify();
    expect(fake.tokensIssued).toBe(2);
  });

  it("assumes a sensible lifetime when the server does not say", async () => {
    fake.tokenExpiresIn = undefined;
    fake.addUser();
    await identify();
    await identify();
    expect(fake.tokensIssued).toBe(1);
  });
});

describe("oauth: a token that stops working", () => {
  beforeEach(() => useOauth());

  it("gets one fresh token and retries once when ServiceNow answers 401", async () => {
    fake.addUser();
    await identify(); // token-1 cached
    fake.validTokens.clear(); // ServiceNow revokes it

    const result = await identify();

    expect(result.status).toBe("identified");
    expect(fake.tokensIssued).toBe(2);
    expect(tableCalls().at(-1)?.headers.Authorization).toBe("Bearer token-2");
  });

  it("does not loop when 401 persists: one retry, then a clear 'error'", async () => {
    fake.override = (c) => (c.path.startsWith("/api/now/table") ? jsonResponse(401, {}) : undefined);
    const result = await identify();

    expect(result).toMatchObject({ status: "error", reason: "http_401" });
    expect(fake.tokensIssued).toBe(2);
    expect(tableCalls()).toHaveLength(2);
  });
});

describe("oauth: the token call fails", () => {
  it("wrong client secret: a permanent 'error', and no table call is made", async () => {
    useOauth(JSON.stringify({ instance_url: INSTANCE, auth: "oauth", client_id: CLIENT_ID, client_secret: "wrong" }));
    const result = await identify();
    expect(result).toMatchObject({ status: "error", reason: "oauth_http_401", callerKnown: "false" });
    expect(tableCalls()).toHaveLength(0);
  });

  it("token endpoint down: 'degraded', so it is worth trying again", async () => {
    useOauth();
    fake.override = (c) => (c.path === "/oauth_token.do" ? jsonResponse(503, {}) : undefined);
    const result = await identify();
    expect(result).toMatchObject({ status: "degraded", reason: "oauth_http_503" });
  });

  it("a token reply with no access_token is an 'error'", async () => {
    useOauth();
    fake.override = (c) => (c.path === "/oauth_token.do" ? jsonResponse(200, { token_type: "Bearer" }) : undefined);
    expect(await identify()).toMatchObject({ status: "error", reason: "oauth_bad_response" });
  });

  it("a token reply that is not JSON (a sleeping instance) is 'degraded'", async () => {
    useOauth();
    fake.override = (c) =>
      c.path === "/oauth_token.do" ? new Response("<html>hibernating</html>", { status: 200 }) : undefined;
    expect(await identify()).toMatchObject({ status: "degraded", reason: "oauth_bad_response" });
  });

  it("the token call counts against the time budget", async () => {
    useOauth();
    process.env.SERVICENOW_TOTAL_BUDGET_SEC = "0";
    expect(await identify()).toMatchObject({ status: "degraded", reason: "budget_exhausted" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("oauth: what must stay secret", () => {
  it("never logs or returns the client secret or the token", async () => {
    useOauth();
    const out = captureConsole();
    fake.addUser();

    const results = [
      await identify(),
      await handler(flowEvent({ action: "create_incident", category: "1" })),
      await handler(flowEvent({ action: "create_request", requestType: "1", digits: "1357" })),
    ];
    fake.validTokens.clear();
    results.push(await identify()); // a 401 and a refresh

    const everything = out.text() + JSON.stringify(results);
    for (const secret of [CLIENT_SECRET, "token-1", "token-2", CLIENT_ID]) {
      expect(everything, secret).not.toContain(secret);
    }
  });

  it.each([
    "http://dev12345.service-now.com",
    "https://evil.example.com",
    "https://dev12345.service-now.com.evil.example.com",
  ])("never sends the client secret to %s", async (instanceUrl) => {
    useOauth(JSON.stringify({ instance_url: instanceUrl, auth: "oauth", client_id: CLIENT_ID, client_secret: CLIENT_SECRET }));
    expect(await identify()).toMatchObject({ status: "error", reason: "instance_url_not_servicenow" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses an oauth secret that is missing the client secret", async () => {
    useOauth(JSON.stringify({ instance_url: INSTANCE, auth: "oauth", client_id: CLIENT_ID }));
    expect(await identify()).toMatchObject({ status: "error", reason: "secret_missing_keys" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("choosing between oauth and basic", () => {
  it("uses basic when the secret says so, with no token call", async () => {
    ({ fake } = install());
    fake.addUser();
    await identify();
    expect(fake.callsTo("POST", "/oauth_token.do")).toHaveLength(0);
    expect(tableCalls()[0]?.headers.Authorization).toBe(BASIC);
  });

  it("works out 'oauth' from the keys when 'auth' is missing", async () => {
    useOauth(JSON.stringify({ instance_url: INSTANCE, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }));
    fake.addUser();
    expect((await identify()).status).toBe("identified");
    expect(fake.callsTo("POST", "/oauth_token.do")).toHaveLength(1);
  });

  it("works out 'basic' from the keys when 'auth' is missing", async () => {
    ({ fake } = install(JSON.stringify({ instance_url: INSTANCE, username: USERNAME, password: PASSWORD })));
    fake.addUser();
    expect((await identify()).status).toBe("identified");
    expect(fake.callsTo("POST", "/oauth_token.do")).toHaveLength(0);
  });

  it("does not retry a 401 under basic auth (a password does not refresh)", async () => {
    ({ fake } = install());
    fake.override = (c) => (c.path.startsWith("/api/now/table") ? jsonResponse(401, {}) : undefined);
    expect(await identify()).toMatchObject({ status: "error", reason: "http_401" });
    expect(tableCalls()).toHaveLength(1);
  });
});
