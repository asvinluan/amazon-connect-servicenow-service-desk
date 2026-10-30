import { describe, expect, it } from "vitest";

import { last4, normalise, PHONE_RE, phoneVariants } from "../src/phone";

describe("normalise", () => {
  it("keeps E.164 as it is", () => {
    expect(normalise("+61355500101")).toBe("+61355500101");
  });

  it("strips spaces, brackets and dashes", () => {
    expect(normalise("+61 (3) 5550-0101")).toBe("+61355500101");
  });

  it("turns the Australian national form into E.164", () => {
    expect(normalise("0412 345 678")).toBe("+61412345678");
  });

  it("returns an empty string for a withheld caller id", () => {
    expect(normalise(undefined)).toBe("");
    expect(normalise(null)).toBe("");
    expect(normalise("")).toBe("");
  });
});

describe("phoneVariants", () => {
  it("adds the national form for an Australian number", () => {
    expect(phoneVariants("+61412345678")).toEqual(["+61412345678", "0412345678"]);
  });

  it("does not invent a national form for other countries", () => {
    expect(phoneVariants("+14155550100")).toEqual(["+14155550100"]);
  });
});

describe("PHONE_RE", () => {
  it("accepts digits with an optional plus and refuses everything else", () => {
    expect(PHONE_RE.test("+61355500101")).toBe(true);
    expect(PHONE_RE.test("0355500101")).toBe(true);
    // These are what an injection attempt into a ServiceNow query would look like.
    expect(PHONE_RE.test("0355500101^ORactive=true")).toBe(false);
    expect(PHONE_RE.test("anonymous")).toBe(false);
    expect(PHONE_RE.test("12345")).toBe(false);
  });
});

describe("last4", () => {
  it("never returns more than four digits", () => {
    expect(last4("+61355500101")).toBe("0101");
    expect(last4("")).toBe("");
  });
});
