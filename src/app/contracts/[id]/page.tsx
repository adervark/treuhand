import type { Metadata } from "next";
import { connection } from "next/server";
import { ContractView } from "@/components/contract/contract-view";
import { getContract } from "@/lib/db/contracts";
import { listIdentities } from "@/lib/db/identities";
import { getViewerRole } from "@/lib/viewer";

/** The tab and a shared link carry the contract's own title. */
export async function generateMetadata({ params }: PageProps<"/contracts/[id]">): Promise<Metadata> {
  const { id } = await params;
  await connection();
  const contract = getContract(id);
  return { title: contract ? contract.title : "Contract" };
}

export default async function ContractPage({ params }: PageProps<"/contracts/[id]">) {
  const { id } = await params;
  await connection(); // better-sqlite3 is synchronous: read at request time, not at build
  const role = await getViewerRole();
  const identities = listIdentities();
  return <ContractView id={id} role={role} identities={identities} />;
}
