import { AlertTriangle } from "lucide-react";

/**
 * Rendered when the app is booted without VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.
 * Every network call would fail until these are set; showing a clear message is
 * kinder than a stack trace.
 */
export function SetupRequired() {
  return (
    <div className="min-h-full grid place-items-center bg-surface/40 p-4">
      <div className="w-full max-w-md rounded-lg border border-warn/30 bg-white shadow-card p-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-warn">
            <AlertTriangle size={22} />
          </span>
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-ink">Supabase is not configured</h1>
            <p className="mt-1 text-sm text-muted">
              The application can start, but it can't talk to any database yet. To finish setup:
            </p>
            <ol className="mt-3 text-sm text-ink list-decimal ml-5 space-y-1.5">
              <li>
                Copy <code className="bg-surface px-1 rounded">.env.example</code> to{" "}
                <code className="bg-surface px-1 rounded">.env.local</code>.
              </li>
              <li>
                Set <code className="bg-surface px-1 rounded">VITE_SUPABASE_URL</code> and{" "}
                <code className="bg-surface px-1 rounded">VITE_SUPABASE_ANON_KEY</code> to your Supabase
                project's URL and publishable (or legacy anon) key.
              </li>
              <li>Restart the dev server.</li>
            </ol>
            <p className="mt-3 text-xs text-subtle">
              See <code>README.md</code> for the full setup, including how to run the SQL migrations
              and deploy the admin Edge Functions.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
