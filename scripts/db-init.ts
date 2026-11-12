/** Creates the database file if needed and applies pending migrations. Safe to rerun. */
import { closeDb, dbPath, getDb } from "@/lib/db";

const db = getDb();
const version = db.pragma("user_version", { simple: true });
console.log(`database ready at ${dbPath()} (schema version ${version})`);
closeDb();
