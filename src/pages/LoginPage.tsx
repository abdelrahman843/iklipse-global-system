import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AlertCircle, ArrowRight, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { BrandMark } from "@/components/Brand";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/ui/Toast";

// -----------------------------------------------------------------------------
// The gate, in the iklipse central hub's design: brand lockup, a "Team
// Workspace" pill, a large title, two bare fields and one bright button.
// -----------------------------------------------------------------------------

const field =
  "h-12 w-full rounded-lg border border-ink/[0.08] bg-ink/5 px-4 text-[14px] text-ink outline-none backdrop-blur-sm transition-colors placeholder:text-subtle focus:border-ink/40";

export function LoginPage() {
  const { session, signIn, signOut, ready } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Adding another account (profile menu): the one signed in stays saved on
  // this device, and this page stays until the new one signs in.
  const adding = new URLSearchParams(loc.search).get("add") === "1";
  const startUser = useRef(session?.user?.id ?? null);

  useEffect(() => {
    const params = new URLSearchParams(loc.search);
    if (params.get("state") === "deactivated") {
      (async () => {
        await signOut();
        toast.push({
          kind: "error",
          title: "You're no longer on the team",
          description: "An admin marked you as left. Ask one to bring you back.",
        });
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.search]);

  useEffect(() => {
    // Opened fresh: the first login that loads is the one already here.
    if (adding && session && startUser.current === null) startUser.current = session.user.id;
    if (ready && session && !(adding && session.user.id === startUser.current)) {
      // Back where they were going, query included (the OAuth consent page needs its id).
      const f = (loc.state as { from?: { pathname?: string; search?: string } } | null)?.from;
      const from = f?.pathname ? `${f.pathname}${f.search ?? ""}` : "/";
      nav(from, { replace: true });
    }
  }, [ready, session, nav, loc.state, adding]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!identifier.trim() || !password) {
      setErr("Enter your username and password.");
      return;
    }
    setBusy(true);
    try {
      await signIn(identifier.trim(), password);
      if (adding) nav("/", { replace: true });
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : "Sign in failed.";
      setErr(m);
    } finally {
      setBusy(false);
    }
  }

  return (
    // The iklipse central hub's sign-in: no card, the form floats on the
    // near-black backdrop with a warm glow rising from the bottom.
    <div className="hub-bg relative isolate min-h-dvh flex items-center justify-center overflow-hidden px-4 py-16">
      <div className="hub-grain pointer-events-none fixed inset-0 -z-10" aria-hidden />
      <div className="hub-glow pointer-events-none absolute inset-0 -z-10 opacity-25" aria-hidden />
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-[0.08] blur-[130px]"
        aria-hidden
      />

      <div className="relative w-full max-w-sm animate-scale-in">
        <form onSubmit={onSubmit} noValidate>
          <div className="mb-8 flex flex-col items-center text-center">
            <BrandMark className="mb-5" />
            <span className="mb-4 rounded-full border border-ink/[0.08] bg-ink/5 px-3 py-1 text-[0.64rem] uppercase tracking-[0.18em] text-muted">
              Team Workspace
            </span>
            <h1 className="text-[30px] leading-9 font-semibold tracking-[-0.03em] text-ink">{adding ? "Add an account" : "Sign in"}</h1>
            {adding && <p className="mt-2 text-[0.8rem] text-muted">You stay signed in to the others. Switch between them from your profile menu.</p>}
          </div>

          {err && (
            <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-[0.78rem] text-danger">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              {err}
            </div>
          )}

          <div className="space-y-3">
            <input
              id="identifier"
              aria-label="Username"
              autoComplete="username"
              autoFocus
              value={identifier}
              onChange={(e) => {
                setIdentifier(e.target.value);
                setErr(null);
              }}
              placeholder="Username"
              className={field}
            />
            <div className="relative">
              <input
                id="password"
                aria-label="Password"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setErr(null);
                }}
                placeholder="Password"
                className={cn(field, "pr-12")}
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? "Hide password" : "Show password"}
                className="absolute inset-y-0 right-0 px-4 flex items-center text-subtle hover:text-ink"
              >
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-ink text-[14px] font-medium text-bg shadow-[0_10px_26px_-18px_rgba(0,0,0,0.6)] transition-transform duration-150 hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100"
            >
              {busy ? "Signing in…" : "Sign in"} {!busy && <ArrowRight size={16} />}
            </button>
          </div>

          {adding && session && (
            <Link to="/" replace className="mt-4 block text-center text-[0.8rem] text-muted hover:text-ink">
              Cancel
            </Link>
          )}

          <div className="mt-5 flex items-start gap-2 rounded-lg bg-ink/[0.025] p-3 text-[0.72rem] text-muted shadow-[inset_0_0_0_1px_rgb(var(--c-ink)/0.08)]">
            <ShieldCheck size={14} className="mt-0.5 shrink-0 text-subtle" />
            Sign-up is invite-only. Accounts are created by an admin, there is no public registration.
          </div>
        </form>
      </div>
    </div>
  );
}
