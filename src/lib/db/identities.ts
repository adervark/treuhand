import { IdentitySchema, type Identity, type Party } from "@/lib/types";
import { getDb } from "./index";

/** Inserts or replaces the demo identity for a role. */
export function upsertIdentity(input: Identity): Identity {
  const identity = IdentitySchema.parse(input);
  getDb()
    .prepare(
      `INSERT INTO identities (role, display_name, email) VALUES (@role, @display_name, @email)
       ON CONFLICT (role) DO UPDATE SET display_name = excluded.display_name, email = excluded.email`,
    )
    .run(identity);
  return identity;
}

export function getIdentity(role: Party): Identity | null {
  const row = getDb().prepare(`SELECT * FROM identities WHERE role = ?`).get(role);
  return row ? IdentitySchema.parse(row) : null;
}

/** Payer first, then worker. */
export function listIdentities(): Identity[] {
  return getDb()
    .prepare(`SELECT * FROM identities ORDER BY CASE role WHEN 'payer' THEN 0 ELSE 1 END`)
    .all()
    .map((row) => IdentitySchema.parse(row));
}
