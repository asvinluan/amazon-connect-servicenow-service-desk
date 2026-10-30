// Structural checks on the contact flow template.
//
// A flow is a graph: every block names the block that comes next. A typo in one
// name produces a branch that goes nowhere, and nothing complains until a caller
// hits it. These tests read the generated template and prove the wiring.
//
// They also check the security rules that live in the flow rather than the Lambda:
// the digits a caller keys in are never copied onto the contact, and the name of
// the person behind a phone number is never spoken.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TEMPLATE = `${ROOT}terraform/flows/servicedesk.json.tftpl`;

interface Block {
  Identifier: string;
  Type: string;
  Parameters: Record<string, unknown>;
  Transitions: {
    NextAction?: string;
    Errors?: { NextAction: string; ErrorType: string }[];
    Conditions?: { NextAction: string }[];
  };
}
interface Flow {
  StartAction: string;
  Metadata: { ActionMetadata: Record<string, unknown> };
  Actions: Block[];
}

const raw = readFileSync(TEMPLATE, "utf8");
const flow = JSON.parse(raw.replace(/\$\{(lambda_arn|queue_arn)\}/g, "arn:$1")) as Flow;
const byId = new Map(flow.Actions.map((b) => [b.Identifier, b]));

function targets(b: Block): string[] {
  const t = b.Transitions;
  return [
    ...(t.NextAction ? [t.NextAction] : []),
    ...(t.Errors ?? []).map((e) => e.NextAction),
    ...(t.Conditions ?? []).map((c) => c.NextAction),
  ];
}

const TERMINAL = new Set(["EndFlowExecution", "DisconnectParticipant"]);

/** Every path from the start to a terminal block, with the attributes set along the way. */
function* paths(
  id: string,
  seen: string[] = [],
  attrs: Set<string> = new Set(),
): Generator<{ route: string[]; attrs: Set<string> }> {
  const b = byId.get(id);
  if (!b) throw new Error(`no block ${id}`);
  const route = [...seen, id];
  const here = new Set(attrs);
  if (b.Type === "UpdateContactAttributes") {
    for (const k of Object.keys(b.Parameters.Attributes as object)) here.add(k);
  }
  if (TERMINAL.has(b.Type)) {
    yield { route, attrs: here };
    return;
  }
  for (const next of new Set(targets(b))) {
    if (seen.includes(next)) throw new Error(`loop at ${next}`);
    yield* paths(next, route, here);
  }
}

describe("the generated template", () => {
  it("is exactly what tools/gen-flow.mjs produces", () => {
    const out = execFileSync(process.execPath, [`${ROOT}tools/gen-flow.mjs`, "--check"], { encoding: "utf8" });
    expect(out).toContain("up to date");
  });

  it("uses only the two Terraform placeholders", () => {
    const found = new Set([...raw.matchAll(/\$\{([a-z_]+)\}/g)].map((m) => m[1]));
    expect([...found].sort()).toEqual(["lambda_arn", "queue_arn"]);
  });
});

describe("the wiring", () => {
  it("has unique block names and a start block that exists", () => {
    expect(byId.size).toBe(flow.Actions.length);
    expect(byId.has(flow.StartAction)).toBe(true);
  });

  it("points every transition at a block that exists", () => {
    for (const b of flow.Actions) {
      for (const t of targets(b)) expect(byId.has(t), `${b.Identifier} -> ${t}`).toBe(true);
    }
  });

  it("reaches every block from the start (no orphans)", () => {
    const reached = new Set<string>();
    const walk = (id: string) => {
      if (reached.has(id)) return;
      reached.add(id);
      for (const t of targets(byId.get(id) as Block)) walk(t);
    };
    walk(flow.StartAction);
    expect([...byId.keys()].filter((id) => !reached.has(id))).toEqual([]);
  });

  it("gives every block that is not terminal a way forward", () => {
    for (const b of flow.Actions) {
      if (TERMINAL.has(b.Type)) {
        expect(targets(b), b.Identifier).toEqual([]);
      } else {
        expect(b.Transitions.NextAction, b.Identifier).toBeTruthy();
      }
    }
  });

  it("has no loops, so a caller cannot be trapped", () => {
    expect(() => [...paths(flow.StartAction)]).not.toThrow();
  });

  it("ends every path either in the agent queue or with a goodbye", () => {
    for (const { route } of paths(flow.StartAction)) {
      const last = route.at(-1);
      const queued = route.includes("Q11-Transfer");
      const finished = last === "Z01-Disconnect" && route.includes("T21-SayStatus");
      const refused = last === "Z01-Disconnect" && (route.includes("Q13-AtCapacity") || route.includes("Q14-TransferFailed"));
      expect(queued || finished || refused, route.join(" > ")).toBe(true);
    }
  });

  it("lets every menu and every failed lookup end with an agent, never a dead end", () => {
    for (const id of ["M01-MainMenu", "I01-ProblemType", "R02-RequestType", "T02-Kind"]) {
      const b = byId.get(id) as Block;
      expect(b.Transitions.NextAction, id).toBeTruthy();
      for (const e of b.Transitions.Errors ?? []) expect(e.NextAction, id).toBeTruthy();
    }
  });
});

describe("the Lambda calls", () => {
  const invokes = flow.Actions.filter((b) => b.Type === "InvokeLambdaFunction");
  const ACTIONS = ["identify", "create_incident", "create_request", "status"];

  it("all stay inside Connect's 8-second ceiling and expect a string map", () => {
    expect(invokes.length).toBeGreaterThanOrEqual(6);
    for (const b of invokes) {
      expect(Number(b.Parameters.InvocationTimeLimitSeconds), b.Identifier).toBeLessThanOrEqual(8);
      expect(b.Parameters.ResponseValidation, b.Identifier).toEqual({ ResponseType: "STRING_MAP" });
      expect(b.Parameters.LambdaFunctionARN, b.Identifier).toBe("arn:lambda_arn");
    }
  });

  it("only ask for actions the Lambda implements", () => {
    const handlerSource = readFileSync(`${ROOT}lambda/servicedesk/src/handler.ts`, "utf8");
    for (const b of invokes) {
      const action = (b.Parameters.LambdaInvocationAttributes as Record<string, string>).action as string;
      expect(ACTIONS, b.Identifier).toContain(action);
      expect(handlerSource, action).toContain(`action === "${action}"`);
    }
  });

  it("send the keyed digits straight from the input block, in the same call as the action", () => {
    const withDigits = invokes.filter((b) => "digits" in (b.Parameters.LambdaInvocationAttributes as object));
    expect(withDigits.map((b) => b.Identifier).sort()).toEqual(["R05-Create", "R09-CreateAgain", "T07-Check", "T12-CheckAgain"]);

    for (const b of withDigits) {
      expect((b.Parameters.LambdaInvocationAttributes as Record<string, string>).digits).toBe("$.StoredCustomerInput");
      // The block that feeds it must be a four-digit input block.
      const feeders = flow.Actions.filter((p) => p.Transitions.NextAction === b.Identifier);
      expect(feeders.length, b.Identifier).toBe(1);
      const feeder = feeders[0] as Block;
      expect(feeder.Type).toBe("GetParticipantInput");
      expect(feeder.Parameters.StoreInput).toBe("True");
      expect(feeder.Parameters.InputValidation).toEqual({ CustomValidation: { MaximumLength: "4" } });
    }
  });

  it("allow exactly one retry of the digits, then hand over to the verification-failed message", () => {
    const retryRoutes = [...paths(flow.StartAction)].filter((p) => p.route.includes("R07-SayTryAgain"));
    expect(retryRoutes.length).toBeGreaterThan(0);
    for (const { route } of retryRoutes) {
      expect(route.filter((id) => id === "R07-SayTryAgain")).toHaveLength(1);
    }
    expect(byId.has("V01-SayCouldNotVerify")).toBe(true);
  });
});

describe("what the flow must never do with a caller's secrets", () => {
  it("never copies the keyed digits onto the contact, except the (public) ticket number", () => {
    for (const b of flow.Actions) {
      if (b.Type !== "UpdateContactAttributes") continue;
      for (const [key, value] of Object.entries(b.Parameters.Attributes as Record<string, string>)) {
        if (String(value).includes("StoredCustomerInput")) {
          expect([b.Identifier, key], "only the ticket number may be stored").toEqual(["T05-KeepNumber", "ticketDigits"]);
        }
      }
    }
  });

  it("never gives the person's name a field that is spoken", () => {
    for (const b of flow.Actions) {
      if (b.Type === "MessageParticipant" || b.Type === "GetParticipantInput") {
        const text = String(b.Parameters.Text);
        expect(text, b.Identifier).not.toMatch(/callerMatch|callerName/);
      }
    }
  });

  it("puts a ticket number on the contact before it is read out, on every path", () => {
    for (const { route, attrs } of paths(flow.StartAction)) {
      for (const id of route) {
        const b = byId.get(id) as Block;
        if (b.Type !== "MessageParticipant") continue;
        for (const m of String(b.Parameters.Text).matchAll(/\$\.Attributes\.(\w+)/g)) {
          const name = m[1] as string;
          // Find the attributes set BEFORE this block on this route.
          const before = new Set<string>();
          for (const prior of route.slice(0, route.indexOf(id))) {
            const pb = byId.get(prior) as Block;
            if (pb.Type === "UpdateContactAttributes") {
              for (const k of Object.keys(pb.Parameters.Attributes as object)) before.add(k);
            }
          }
          expect(before.has(name), `${id} reads $.Attributes.${name} but it is not set on ${route.join(" > ")}`).toBe(true);
        }
      }
      void attrs;
    }
  });

  it("never gives a Compare block the NoMatchingError error type (Connect refuses it)", () => {
    for (const b of flow.Actions) {
      if (b.Type !== "Compare") continue;
      const types = (b.Transitions.Errors ?? []).map((e: { ErrorType: string }) => e.ErrorType);
      expect(types, b.Identifier).not.toContain("NoMatchingError");
    }
  });

  it("never gives a stored-input block the InputTimeLimitExceeded error type (Connect refuses it)", () => {
    for (const b of flow.Actions) {
      if (b.Type !== "GetParticipantInput" || b.Parameters.StoreInput !== "True") continue;
      const types = (b.Transitions.Errors ?? []).map((e: { ErrorType: string }) => e.ErrorType);
      expect(types, b.Identifier).not.toContain("InputTimeLimitExceeded");
    }
  });

  it("only lets callers the Lambda recognised into requests and status checks", () => {
    for (const first of ["R01-CheckKnown", "T01-CheckKnown"]) {
      const b = byId.get(first) as Block;
      expect(b.Type).toBe("Compare");
      expect(b.Parameters.ComparisonValue).toBe("$.Attributes.callerKnown");
      expect(b.Transitions.NextAction).toBe("X01-SayNotRecognised");
    }
  });

  it("marks the contact as verified only after a successful verified answer", () => {
    for (const b of flow.Actions) {
      if (b.Type !== "UpdateContactAttributes") continue;
      const attrs = b.Parameters.Attributes as Record<string, string>;
      if (attrs.callerVerified === "true") expect(["R10-SetTicket", "T20-SetStatus"]).toContain(b.Identifier);
    }
    const start = byId.get("S04-SetCallerAttributes") as Block;
    expect((start.Parameters.Attributes as Record<string, string>).callerVerified).toBe("false");
  });
});
