// The id the website passes to Stripe as `client_reference_id`: an Airtable
// record id, or the signup id of a member who signed up in CiviCRM alone.
// Stripe passes it on from the checkout link, so it is user input.
const AIRTABLE_RECORD_ID_REGEX = /^rec[a-zA-Z0-9]{14}$/;
const SIGNUP_ID_REGEX = /^mem[a-zA-Z0-9]{22}$/;

export type MemberIdKind = "airtable" | "signup";

export function memberIdKind(id: string | null): MemberIdKind | null {
  if (id && AIRTABLE_RECORD_ID_REGEX.test(id)) return "airtable";
  if (id && SIGNUP_ID_REGEX.test(id)) return "signup";
  return null;
}

type PaymentStatusWriter = (memberId: string, status: boolean) => Promise<void>;

export interface PaymentStatusWriters {
  airtable: PaymentStatusWriter;
  /** Null when the CRM settings are unset. */
  crm: PaymentStatusWriter | null;
}

/**
 * Writes the payment status to Airtable (Airtable record ids only) and to
 * CiviCRM (every id). An id of neither shape is logged and ignored, since a
 * retry cannot fix it. Both writes are idempotent, so when either fails this
 * rejects and Stripe retries both.
 */
export async function writePaymentStatus(
  memberId: string | null,
  status: boolean,
  writers: PaymentStatusWriters
): Promise<void> {
  const kind = memberIdKind(memberId);
  if (!kind) {
    console.error(
      `Ignoring client_reference_id that is neither an Airtable record id nor a signup id: ${JSON.stringify(memberId)?.slice(0, 64)}`
    );
    return;
  }
  if (kind === "signup" && !writers.crm) {
    // Rejecting keeps the event in Stripe's retries until the CRM settings are set.
    throw new Error(`No CRM settings to record payment status for signup id ${memberId}`);
  }
  const writes = [
    ...(kind === "airtable" ? [writers.airtable(memberId, status)] : []),
    ...(writers.crm ? [writers.crm(memberId, status)] : []),
  ];
  const failure = (await Promise.allSettled(writes)).find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure) throw failure.reason;
}
