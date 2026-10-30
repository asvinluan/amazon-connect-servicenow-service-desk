import { describe, expect, it } from "vitest";

import { checkCustomerDigits } from "../src/verify";

describe("checkCustomerDigits", () => {
  it("passes when the last four digits match", () => {
    expect(checkCustomerDigits("CUST-48201357", "1357")).toBe("ok");
    expect(checkCustomerDigits("48201357", "1357")).toBe("ok");
  });

  it("ignores letters and dashes in the stored number", () => {
    expect(checkCustomerDigits("AB-12-34-56-78", "5678")).toBe("ok");
  });

  it("fails when any one of the four digits is wrong, first or last", () => {
    expect(checkCustomerDigits("CUST-48201357", "9357")).toBe("wrong_digits");
    expect(checkCustomerDigits("CUST-48201357", "1957")).toBe("wrong_digits");
    expect(checkCustomerDigits("CUST-48201357", "1397")).toBe("wrong_digits");
    expect(checkCustomerDigits("CUST-48201357", "1358")).toBe("wrong_digits");
  });

  it("does not accept the first digits of the number instead of the last", () => {
    expect(checkCustomerDigits("CUST-48201357", "4820")).toBe("wrong_digits");
  });

  it.each(["", "135", "13578", "13a7", " 1357", "1357 ", "+135"])(
    "refuses input that is not exactly four digits: %j",
    (entered) => {
      expect(checkCustomerDigits("CUST-48201357", entered)).toBe("bad_input");
    },
  );

  it.each(["", "no digits here", "12", "1-2-3"])(
    "never passes a user with no usable customer number: %j",
    (ref) => {
      expect(checkCustomerDigits(ref, "1234")).toBe("no_reference");
      expect(checkCustomerDigits(ref, "0000")).toBe("no_reference");
    },
  );
});
