// Sign-in / create-account modal for the public Stitch Lab. Reuses the shared
// Bayside auth backend (see account.ts). Email + password, with an emailed
// 6-digit code to confirm a new account or reset a password.

import { useEffect, useState } from "react";
import { labApi, saveSession } from "./account";

type View = "signin" | "signup" | "signup-code" | "reset" | "reset-code";

export default function AccountModal({ onClose, onSignedIn, initialView = "signin" }: { onClose: () => void; onSignedIn: (email: string) => void; initialView?: "signin" | "signup" | "reset" }) {
  const [view, setView] = useState<View>(initialView);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = (v: View) => { setView(v); setError(null); };

  const succeed = (token: string, mail: string) => {
    saveSession(token, mail);
    onSignedIn(mail);
    onClose();
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (view === "signin") {
      run(async () => {
        const d = await labApi("login", { email, password });
        if (d.token) return succeed(d.token, email);
        if (d.needsCode) { setNote(d.message ?? "We emailed you a code. Enter it to finish."); go("signup-code"); }
      });
    } else if (view === "signup") {
      run(async () => {
        const d = await labApi("signup", { email, password });
        if (d.token) return succeed(d.token, email);
        setNote("We emailed you a 6-digit code. Enter it below to create your account.");
        go("signup-code");
      });
    } else if (view === "signup-code") {
      run(async () => {
        const d = await labApi("signup-verify", { email, code });
        if (d.token) return succeed(d.token, email);
        setError("That code didn't work. Try again.");
      });
    } else if (view === "reset") {
      run(async () => {
        await labApi("reset-request", { email });
        setNote("We emailed you a reset code. Enter it with a new password.");
        go("reset-code");
      });
    } else if (view === "reset-code") {
      run(async () => {
        const d = await labApi("reset-verify", { email, password, code });
        if (d.token) return succeed(d.token, email);
        setError("That code didn't work. Try again.");
      });
    }
  };

  const title =
    view === "signin" ? "Sign in"
    : view === "signup" ? "Create an account"
    : view === "signup-code" ? "Confirm your account"
    : view === "reset" ? "Reset your password"
    : "Set a new password";

  const codeView = view === "signup-code" || view === "reset-code";
  const passwordView = view === "signin" || view === "signup" || view === "reset-code";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-10 bg-fg/40" onClick={onClose}>
      <div className="bg-bg border border-hairline w-full max-w-[400px] shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline">
          <span className="font-serif text-[1.125rem] text-fg">{title}</span>
          <button onClick={onClose} className="text-mid hover:text-fg text-[0.8125rem]">Close ✕</button>
        </div>

        <form className="px-4 py-4 space-y-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {view === "signin" && (
            <p className="text-[0.8125rem] text-mid leading-relaxed">
              An account is optional and free. Signed in, your saved designs back up to your
              account and follow you across browsers and devices.
            </p>
          )}

          {view === "signup" && (
            <p className="text-[0.8125rem] text-mid leading-relaxed">
              Free, just an email and a password. Your saved designs back up to your account,
              so clearing a browser or switching devices never loses work.
            </p>
          )}

          {!codeView && (
            <label className="block">
              <span className="text-[0.6875rem] tracking-[0.14em] uppercase text-mid">Email</span>
              <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full border border-hairline bg-bg text-fg px-2.5 py-2 text-[0.9375rem]" />
            </label>
          )}

          {passwordView && (
            <label className="block">
              <span className="text-[0.6875rem] tracking-[0.14em] uppercase text-mid">{view === "reset-code" ? "New password" : "Password"}</span>
              <input type="password" autoComplete={view === "signin" ? "current-password" : "new-password"} required minLength={8}
                value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder={view === "signin" ? "" : "8+ characters"}
                className="mt-1 w-full border border-hairline bg-bg text-fg px-2.5 py-2 text-[0.9375rem]" />
            </label>
          )}

          {codeView && (
            <>
              {note && <p className="text-[0.8125rem] text-mid leading-relaxed">{note}</p>}
              <label className="block">
                <span className="text-[0.6875rem] tracking-[0.14em] uppercase text-mid">6-digit code</span>
                <input inputMode="numeric" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className="mt-1 w-full border border-hairline bg-bg text-fg px-2.5 py-2 text-[1.125rem] tracking-[0.3em] tabular-nums" />
              </label>
              {view === "reset-code" && (
                <label className="block">
                  <span className="text-[0.6875rem] tracking-[0.14em] uppercase text-mid">New password</span>
                  <input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
                    placeholder="8+ characters" className="mt-1 w-full border border-hairline bg-bg text-fg px-2.5 py-2 text-[0.9375rem]" />
                </label>
              )}
            </>
          )}

          {error && <p className="text-[0.8125rem]" style={{ color: "#c0392b" }}>{error}</p>}

          <button type="submit" disabled={busy}
            className="w-full border border-fg bg-fg text-bg px-4 py-2 text-[0.9375rem] disabled:opacity-50 hover:opacity-85">
            {busy ? "Working…"
              : view === "signin" ? "Sign in"
              : view === "signup" ? "Create account"
              : view === "signup-code" ? "Confirm and sign in"
              : view === "reset" ? "Email me a code"
              : "Set password and sign in"}
          </button>

          <div className="text-[0.8125rem] text-mid flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
            {view === "signin" && <button type="button" className="text-accent hover:underline" onClick={() => go("signup")}>Create an account</button>}
            {view === "signin" && <button type="button" className="hover:text-fg" onClick={() => go("reset")}>Forgot password?</button>}
            {view !== "signin" && <button type="button" className="text-accent hover:underline" onClick={() => go("signin")}>Back to sign in</button>}
          </div>
        </form>
      </div>
    </div>
  );
}
