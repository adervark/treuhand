/**
 * PayPal webhook receiver. Verifies the
 * signature with PayPal against the raw body, then reconciles the event with
 * the ledger and the contract (src/lib/paypal/webhook.ts).
 *
 * Webhooks are a secondary confirmation: the contract service records every PayPal
 * result directly, so the app works without this route ever being called.
 *
 * 200: the event was processed, was a duplicate, or is ignored (PayPal stops
 * retrying). 400: a verified body that is not an event of the expected shape.
 * 401: PayPal did not confirm the signature. 503: PAYPAL_WEBHOOK_ID or the
 * credentials are not set. 502: PayPal could not be asked to verify. 500:
 * the database write failed. PayPal retries every non-2xx (up to 25 times over
 * 3 days), which is safe because handling is idempotent on the event id.
 */
import { ZodError, z } from "zod";
import { MissingEnvError } from "@/lib/env";
import { verifyWebhookSignature } from "@/lib/paypal";
import { handlePayPalWebhookEvent } from "@/lib/paypal/webhook";

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(request: Request): Promise<Response> {
  // Kept as text: PayPal verifies the event exactly as it was sent.
  const rawBody = await request.text();

  let verified: boolean;
  try {
    verified = await verifyWebhookSignature({ headers: request.headers, rawBody });
  } catch (err) {
    if (err instanceof MissingEnvError) return errorResponse(503, "NOT_CONFIGURED", err.message);
    return errorResponse(502, "PAYPAL_ERROR", `Could not verify the webhook signature: ${messageOf(err)}`);
  }
  if (!verified) {
    return errorResponse(401, "INVALID_SIGNATURE", "PayPal did not confirm this webhook's signature.");
  }

  try {
    // verifyWebhookSignature returned true, so the body is JSON.
    return Response.json(handlePayPalWebhookEvent(JSON.parse(rawBody)));
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(400, "VALIDATION_ERROR", `Not a PayPal event of the expected shape: ${z.prettifyError(err)}`);
    }
    return errorResponse(500, "INTERNAL", messageOf(err));
  }
}
