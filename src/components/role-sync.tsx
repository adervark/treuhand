"use client";

/**
 * Keeps a tab in step with the "view as" role (DEF-20). Every tab of one
 * browser shares the `clause_view_as` cookie, so switching role in one tab
 * leaves the others showing the old role. When the cookie no longer matches
 * the role this page was rendered for (checked every 2 s and whenever the tab
 * is focused or shown), or the server refuses an action with ROLE_MISMATCH,
 * the page re-renders for the current role. The server refuses the stale
 * tab's actions either way (`getViewerRole` in src/lib/viewer.ts).
 */
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { Party } from "@/lib/types";
import { ROLE_CHANGED_EVENT } from "./api";

/** The same name as `VIEW_AS_COOKIE` in src/lib/viewer.ts (a server module). */
const VIEW_AS_COOKIE = "clause_view_as";

/** The cookie's role as the server reads it; null when the cookie is not visible here (nothing to compare). */
function cookieRole(): Party | null {
  const match = new RegExp(`(?:^|;\\s*)${VIEW_AS_COOKIE}=([^;]*)`).exec(document.cookie);
  if (!match) return null;
  return match[1] === "worker" ? "worker" : "payer";
}

export function RoleSync({ role }: { role: Party }) {
  const router = useRouter();
  useEffect(() => {
    let refreshedAt = 0;
    const refresh = () => {
      // One refresh at a time: the page re-renders with the new role and this effect restarts.
      if (Date.now() - refreshedAt < 3_000) return;
      refreshedAt = Date.now();
      router.refresh();
    };
    const check = () => {
      const current = cookieRole();
      if (current !== null && current !== role) refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(ROLE_CHANGED_EVENT, refresh);
    const timer = setInterval(check, 2_000);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(ROLE_CHANGED_EVENT, refresh);
      clearInterval(timer);
    };
  }, [role, router]);
  return null;
}
