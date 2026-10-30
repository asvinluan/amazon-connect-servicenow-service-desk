// What goes back to Amazon Connect.
//
// A contact flow can only read a FLAT MAP OF STRINGS from a Lambda (and it is
// capped at 32 KB). Everything returned goes through flat(), so a number or a
// null can never leak out and break a flow in production.

export type FlatMap = Record<string, string>;

const MAX_BYTES = 32_000;

export function flat(fields: Record<string, unknown>): FlatMap {
  const out: FlatMap = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value === null || value === undefined ? "" : String(value);
  }
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > MAX_BYTES) {
    return { status: "error", reason: "too_large", ticketNumber: "", ticketSpoken: "" };
  }
  return out;
}

/** "INC0010005" -> "0 0 1 0 0 0 5", so text-to-speech reads it digit by digit. */
export function spokenDigits(ticketNumber: string): string {
  return ticketNumber.replace(/\D/g, "").split("").join(" ");
}

/** ServiceNow incident states, as the words a caller should hear. */
const INCIDENT_STATE: Record<string, string> = {
  "1": "New",
  "2": "In Progress",
  "3": "On Hold",
  "6": "Resolved",
  "7": "Closed",
  "8": "Canceled",
};

/**
 * A service request carries a text "request state" and the ordinary task state.
 * The text one is the better of the two, so use it first. Anything unfamiliar
 * is reported honestly instead of guessed.
 */
const REQUEST_STATE: Record<string, string> = {
  requested: "Requested",
  approved: "Approved",
  in_process: "In Progress",
  closed_complete: "Closed, complete",
  closed_incomplete: "Closed, incomplete",
  closed_cancelled: "Cancelled",
  closed_rejected: "Rejected",
  closed_skipped: "Closed, skipped",
};

const TASK_STATE: Record<string, string> = {
  "1": "Open",
  "2": "In Progress",
  "3": "Closed, complete",
  "4": "Closed, incomplete",
  "7": "Closed, skipped",
};

export const STATE_UNKNOWN = "not available right now";

export function incidentStateText(state: string): string {
  return INCIDENT_STATE[state] ?? STATE_UNKNOWN;
}

export function requestStateText(requestState: string, state: string): string {
  return REQUEST_STATE[requestState] ?? TASK_STATE[state] ?? STATE_UNKNOWN;
}
