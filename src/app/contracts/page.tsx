import type { Metadata } from "next";
import { connection } from "next/server";
import { ContractList } from "@/components/contract-list";
import { listIdentities } from "@/lib/db/identities";

export const metadata: Metadata = { title: "Contracts" };

export default async function ContractsPage() {
  await connection(); // better-sqlite3 is synchronous: read at request time, not at build
  return <ContractList identities={listIdentities()} />;
}
