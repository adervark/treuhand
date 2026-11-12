"use client";

/**
 * The PayPal checkout button (JS SDK v6). The order is created on our server
 * with intent AUTHORIZE (`POST .../fund/create-order`); on approval our server
 * authorizes it (`POST .../fund/authorize`), which places the hold.
 *
 * Everything PayPal-specific lives in this file so it can be switched to the
 * v5 script (`&intent=authorize`, `paypal.Buttons`) without touching the page.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "../api";
import { Banner, Spinner } from "../ui";

const V6_SCRIPT = "https://www.sandbox.paypal.com/web-sdk/v6/core";

// The parts of the v6 SDK this file calls (shapes from PayPal's v6 sample).
interface PayPalSession {
  start(options: { presentationMode: "auto" | "popup" | "modal" | "redirect" }, order: Promise<{ orderId: string }>): Promise<void>;
}
interface PayPalSdk {
  findEligibleMethods(options: { currencyCode: string }): Promise<{ isEligible(method: string): boolean }>;
  createPayPalOneTimePaymentSession(callbacks: {
    onApprove(data: { orderId: string }): Promise<void>;
    onCancel?(data?: unknown): void;
    onError?(error: unknown): void;
  }): PayPalSession;
}
interface PayPalNamespace {
  createInstance(options: { clientId: string; components: string[]; pageType: string }): Promise<PayPalSdk>;
}

let scriptPromise: Promise<PayPalNamespace> | null = null;

function loadV6(): Promise<PayPalNamespace> {
  const existing = (window as unknown as { paypal?: PayPalNamespace }).paypal;
  if (existing?.createInstance) return Promise.resolve(existing);
  scriptPromise ??= new Promise<PayPalNamespace>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = V6_SCRIPT;
    script.async = true;
    script.onload = () => {
      const paypal = (window as unknown as { paypal?: PayPalNamespace }).paypal;
      if (paypal?.createInstance) resolve(paypal);
      else reject(new Error("The PayPal SDK loaded but did not expose createInstance."));
    };
    script.onerror = () => {
      scriptPromise = null;
      script.remove();
      reject(new Error("Could not load the PayPal SDK from www.sandbox.paypal.com."));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

type Phase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "ineligible" }
  | { kind: "approving" }
  | { kind: "error"; message: string };

export function PayPalButton({
  contractId,
  currency,
  onFunded,
}: {
  contractId: string;
  currency: string;
  /** Called after our server authorized the order (the contract is FUNDED). */
  onFunded: () => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const onFundedRef = useRef(onFunded);
  useEffect(() => {
    onFundedRef.current = onFunded;
  });

  useEffect(() => {
    let cancelled = false;
    let button: HTMLElement | null = null;
    const host = slot.current;

    (async () => {
      try {
        const { paypalClientId } = await api<{ paypalClientId: string }>("/api/config");
        const paypal = await loadV6();
        const sdk = await paypal.createInstance({ clientId: paypalClientId, components: ["paypal-payments"], pageType: "checkout" });
        const methods = await sdk.findEligibleMethods({ currencyCode: currency });
        if (cancelled) return;
        if (!methods.isEligible("paypal")) {
          setPhase({ kind: "ineligible" });
          return;
        }

        const session = sdk.createPayPalOneTimePaymentSession({
          async onApprove({ orderId }) {
            setPhase({ kind: "approving" });
            setNotice(null);
            try {
              await api(`/api/contracts/${contractId}/fund/authorize`, { body: { orderId } });
              onFundedRef.current();
            } catch (err) {
              // The button stays, so the payer can try again. PayPal's raw error is kept on the contract's audit record.
              setPhase({ kind: "ready" });
              setNotice(
                err instanceof ApiError && err.code === "PAYPAL_ERROR"
                  ? "Funding did not complete: PayPal approved, but did not place the hold. Press the PayPal button to try again."
                  : `Funding did not complete: ${errorMessage(err).replace(/[.\s]*$/, ".")} Press the PayPal button to try again.`,
              );
            }
          },
          onCancel() {
            setNotice("Checkout was closed before approving. No money moved.");
          },
          onError(err) {
            setNotice(`PayPal reported an error: ${errorMessage(err)}`);
          },
        });

        if (!host) return;
        button = document.createElement("paypal-button");
        button.setAttribute("type", "pay");
        button.addEventListener("click", () => {
          setNotice(null);
          // Do not await before start(): PayPal's sample warns it breaks the click's transient activation.
          const order = api<{ orderId: string }>(`/api/contracts/${contractId}/fund/create-order`, { method: "POST" })
            .then((d) => ({ orderId: d.orderId }))
            .catch((err: unknown) => {
              setNotice(err instanceof ApiError ? err.message : `Could not create the PayPal order: ${errorMessage(err)}`);
              throw err;
            });
          session.start({ presentationMode: "auto" }, order).catch((err: unknown) => {
            setNotice(`PayPal checkout did not start: ${errorMessage(err)}`);
          });
        });
        host.replaceChildren(button);
        setPhase({ kind: "ready" });
      } catch (err) {
        if (!cancelled) setPhase({ kind: "error", message: errorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
      button?.remove();
    };
  }, [contractId, currency]);

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={slot}
        className={phase.kind === "ready" ? "min-h-11 [&_paypal-button]:block [&_paypal-button]:w-full" : "hidden"}
        data-testid="paypal-slot"
      />
      {phase.kind === "loading" ? (
        <div className="flex h-11 items-center justify-center gap-2 rounded-sm bg-inset tnum text-[0.75rem] text-ink-3 ring-1 ring-rule ring-inset">
          <Spinner /> Loading PayPal checkout…
        </div>
      ) : null}
      {phase.kind === "approving" ? (
        <div className="flex h-11 items-center justify-center gap-2 border border-rule bg-surface-2 text-[0.75rem] font-semibold text-held shadow-[inset_3px_0_0_var(--held)]">
          <Spinner /> Placing the hold with PayPal…
        </div>
      ) : null}
      {phase.kind === "ineligible" ? (
        <Banner tone="warn" title="PayPal is not available for this payment">
          PayPal says its button is not eligible for {currency} payments with this sandbox app.
        </Banner>
      ) : null}
      {phase.kind === "error" ? <Banner title="PayPal checkout is unavailable">{phase.message}</Banner> : null}
      {notice ? <p className="text-[0.8rem] text-ink-2" role="status">{notice}</p> : null}
    </div>
  );
}
