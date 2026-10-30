// Caller verification: the second factor after the phone number.
//
// The caller ID (ANI) says which ServiceNow user to look at, but caller ID can
// be faked, so on its own it proves nothing. Before anything about a person is
// read out or a request is made in their name, the caller must also key in the
// last four digits of their customer number, and that must match the record.
//
// In this lab the "customer number" is the Employee ID field on the ServiceNow
// user record (employee_number). It stands in for a bank customer number or a
// staff ID. A real system would verify against its system of record and would
// use something stronger (a one-time code, a voice biometric, a PIN).
//
// Rules that matter:
//   * The comparison takes the same time whether the first digit or the last is
//     wrong (timingSafeEqual), so the response time reveals nothing.
//   * The answer is a short reason code. Neither the entered digits nor the
//     stored number are ever logged or returned.
import { timingSafeEqual } from "node:crypto";

export type VerifyResult = "ok" | "wrong_digits" | "no_reference" | "bad_input";

const FOUR_DIGITS = /^\d{4}$/;

export function checkCustomerDigits(customerRef: string, entered: string): VerifyResult {
  if (!FOUR_DIGITS.test(entered)) return "bad_input";

  const digits = customerRef.replace(/\D/g, "");
  // The user record has no usable customer number: verification is impossible,
  // and that must never be treated as a pass.
  if (digits.length < 4) return "no_reference";

  const expected = Buffer.from(digits.slice(-4), "utf8");
  const given = Buffer.from(entered, "utf8");
  return timingSafeEqual(expected, given) ? "ok" : "wrong_digits";
}
