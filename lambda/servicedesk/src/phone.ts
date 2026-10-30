// Phone number helpers. Same rules as the Salesforce lookup, on purpose, so the
// two integrations treat a caller's number the same way.

/** Digits with an optional leading plus, 6 to 15 long. Anything else is refused. */
export const PHONE_RE = /^\+?\d{6,15}$/;

/** Reduce a caller number to E.164-ish form: digits and a leading plus. */
export function normalise(raw: string | null | undefined): string {
  if (!raw) return "";
  let cleaned = [...raw].filter((c) => (c >= "0" && c <= "9") || c === "+").join("");
  // 04xx xxx xxx (Australian national form) becomes +614xxxxxxxx.
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    cleaned = `+61${cleaned.slice(1)}`;
  }
  return cleaned;
}

/**
 * The ways an Australian number is commonly stored in a ServiceNow phone field.
 *
 * ServiceNow phone fields are free text, so a match only works on the format the
 * record was typed in. Try E.164 and the national 0-prefixed form.
 */
export function phoneVariants(e164: string): string[] {
  const variants = [e164];
  if (e164.startsWith("+61") && e164.length === 12) {
    variants.push(`0${e164.slice(3)}`);
  }
  return variants;
}

/** Last four digits, for logs. Never log more of a caller's number than this. */
export function last4(number: string): string {
  return number ? number.slice(-4) : "";
}
