"use server";

import { cookies } from "next/headers";
import { PartySchema } from "@/lib/types";
import { VIEW_AS_COOKIE } from "@/lib/viewer";

/** Switches the "view as" role. Setting the cookie re-renders the current page. */
export async function setViewAs(formData: FormData): Promise<void> {
  const role = PartySchema.parse(formData.get("role"));
  (await cookies()).set(VIEW_AS_COOKIE, role, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 30 });
}
