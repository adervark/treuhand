import { paypalConfig } from "@/lib/contract/service";
import { handle, json } from "../_lib/http";

/** `GET /api/config`: the PayPal client id for the checkout button. */
export async function GET(): Promise<Response> {
  return handle(() => json(paypalConfig()));
}
