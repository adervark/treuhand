import type { Metadata } from "next";
import { LedgerView } from "@/components/ledger/ledger-view";

export const metadata: Metadata = { title: "Ledger" };

export default function LedgerPage() {
  return <LedgerView />;
}
