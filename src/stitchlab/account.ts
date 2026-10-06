// Stitch Lab accounts. These reuse the same backend and session as the
// Customizer Lab (/api/lab), so one Bayside account works across both tools.
// The session token and email live in the same localStorage keys the Lab uses,
// which means signing in on either side signs you in on the other. No backend
// changes: this is a client that calls the existing, live auth endpoints.

import { apiBase } from "./lib/native";

const API = `${apiBase()}/api/lab`;
const TOKEN_KEY = "bayside-lab-token";
const EMAIL_KEY = "bayside-lab-email";

export type Session = { token: string; email: string };

export function getSession(): Session | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const email = localStorage.getItem(EMAIL_KEY);
    return token && email ? { token, email } : null;
  } catch {
    return null;
  }
}

export function saveSession(token: string, email: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(EMAIL_KEY, email);
  } catch {
    /* storage blocked */
  }
}

/** "admin" | "staff" | "user" - as of the last account sync. */
export function getRole(): string {
  try { return localStorage.getItem("bayside-lab-role") ?? "user"; } catch { return "user"; }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
    localStorage.removeItem("bayside-lab-role");
  } catch {
    /* ignore */
  }
}

type LabResponse = {
  token?: string;
  email?: string;
  needsCode?: boolean;
  message?: string;
  error?: string;
  [k: string]: unknown;
};

/** Call the shared Bayside auth backend. Throws with a readable message on a
 *  non-2xx response so the UI can show it. */
export async function labApi(action: string, body: Record<string, unknown> = {}): Promise<LabResponse> {
  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as LabResponse;
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}
