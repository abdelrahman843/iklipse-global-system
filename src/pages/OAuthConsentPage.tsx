import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Bot, Check, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PageSpinner } from "@/components/ui/Spinner";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";

// -----------------------------------------------------------------------------
// OAuth consent (Supabase Auth's OAuth server): ChatGPT, Claude or another MCP
// client asks to use the person's Iklipse account through the MCP server.
// Supabase sends people here with ?authorization_id=...; they approve or deny
// and go back to the app that asked.
// -----------------------------------------------------------------------------

interface Details {
  authorization_id: string;
  client: { name?: string; client_name?: string; uri?: string; client_uri?: string };
  redirect_uri?: string;
  scope?: string;
}

export default function OAuthConsentPage() {
  const [params] = useSearchParams();
  const id = params.get("authorization_id") ?? "";
  const { profile } = useAuth();
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);

  useEffect(() => {
    if (!id) {
      setError("This sign-in request is missing its id. Start again from the app you're connecting.");
      return;
    }
    void (async () => {
      const { data, error: e } = await supabase.auth.oauth.getAuthorizationDetails(id);
      if (e || !data) return setError(e?.message ?? "This request has expired. Start again from the app you're connecting.");
      // Already approved before: straight back.
      if (!("authorization_id" in data)) {
        window.location.href = data.redirect_url;
        return;
      }
      setDetails(data as unknown as Details);
    })();
  }, [id]);

  const decide = async (allow: boolean) => {
    setBusy(allow ? "allow" : "deny");
    const { data, error: e } = allow
      ? await supabase.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true })
      : await supabase.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true });
    if (e || !data?.redirect_url) {
      setBusy(null);
      return setError(e?.message ?? "Couldn't finish. Start again from the app you're connecting.");
    }
    window.location.href = data.redirect_url;
  };

  if (!details && !error) return <PageSpinner />;
  const name = details?.client.name || details?.client.client_name || "An app";
  let host = "";
  try {
    host = details?.redirect_uri ? new URL(details.redirect_uri).host : "";
  } catch {
    host = "";
  }

  return (
    <div className="min-h-dvh grid place-items-center bg-bg px-4 py-8">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface shadow-raise p-6 animate-scale-in">
        <div className="display text-[20px] text-ink">iklipse</div>
        {error ? (
          <>
            <h1 className="mt-4 text-lg font-semibold text-ink">Couldn't connect</h1>
            <p className="mt-1 text-sm text-muted">{error}</p>
          </>
        ) : (
          <>
            <div className="mt-4 flex items-center gap-3">
              <span className="h-11 w-11 rounded-lg bg-accent-soft text-accent grid place-items-center shrink-0">
                <Bot size={22} />
              </span>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold text-ink leading-snug">{name} wants to use your iklipse account</h1>
                {host && <div className="text-xs text-subtle truncate">Sends you back to {host}</div>}
              </div>
            </div>
            <p className="mt-4 text-sm text-muted">
              Signed in as <span className="text-ink font-medium">{profile?.display_name}</span>. It will act as you, with exactly your permissions:
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-ink">
              {[
                "See the Trello and Miro boards you can see, with their cards, comments and notes",
                "Create and update Trello cards and comment on them",
                "Add sticky notes and comments on Miro boards",
                "Read your notifications",
              ].map((t) => (
                <li key={t} className="flex gap-2">
                  <Check size={15} className="mt-0.5 text-success shrink-0" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-subtle flex gap-1.5">
              <ShieldCheck size={14} className="shrink-0 mt-px" />
              It can't delete anything, and you can disconnect it any time from the app you connected.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => decide(false)} loading={busy === "deny"} disabled={!!busy}>
                Deny
              </Button>
              <Button variant="primary" onClick={() => decide(true)} loading={busy === "allow"} disabled={!!busy}>
                Allow
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
