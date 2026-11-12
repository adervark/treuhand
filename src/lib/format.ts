/** The one currency a contract is made in: the PayPal account and the Payouts to workers are in US dollars. */
export const CONTRACT_CURRENCY = "USD";

/** The most one contract may be for, $5,000.00: well under PayPal's per-transaction limits, so funding is never refused for size. */
export const MAX_AMOUNT_CENTS = 500_000;

export function formatCents(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountCents / 100);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}
