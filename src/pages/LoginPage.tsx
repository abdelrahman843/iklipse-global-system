import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label, FieldError } from "@/components/ui/Input";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";

// -----------------------------------------------------------------------------
// The gate. Orderful pattern: centered paper card on vellum canvas, uppercase
// eyebrow above a large display title, single vermillion CTA at the bottom.
// -----------------------------------------------------------------------------

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

  useEffect(() => {
    const params = new URLSearchParams(loc.search);
    if (params.get("state") === "deactivated") {
      (async () => {
        await signOut();
        toast.push({
          kind: "error",
          title: "Account deactivated",
          description: "Ask an administrator to reactivate your account.",
        });
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.search]);

  useEffect(() => {
    if (ready && session) {
      const from = (loc.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? "/";
      nav(from, { replace: true });
    }
  }, [ready, session, nav, loc.state]);

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
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : "Sign in failed.";
      setErr(m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full grid place-items-center bg-bg p-3 sm:p-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface shadow-pop p-5 sm:p-8">
        <div className="eyebrow text-subtle mb-6">Iklipse · Control panel</div>

        <h1 className="display text-[28px] leading-tight mb-6">Sign in</h1>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="identifier">Username</Label>
            <Input
              id="identifier"
              autoComplete="username"
              autoFocus
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="e.g. ahmed"
              required
            />
          </div>

          <div>
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pr-10"
                required
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? "Hide password" : "Show password"}
                className="absolute inset-y-0 right-0 px-2 flex items-center text-subtle hover:text-ink"
              >
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <FieldError>{err}</FieldError>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full mt-2"
            loading={busy}
          >
            {busy ? "Working…" : "Sign in"}
          </Button>
        </form>

        <p className="mt-6 text-xs text-subtle">
          Employee accounts are created by an administrator. There is no public sign-up.
        </p>
      </div>
    </div>
  );
}
