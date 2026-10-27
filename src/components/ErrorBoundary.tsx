import { Component, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";

// -----------------------------------------------------------------------------
// A page that breaks shows what happened and a way back, instead of an empty
// white screen. Going to another page (a new resetKey) clears it; the pages
// themselves are not remounted.
// -----------------------------------------------------------------------------

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="min-h-dvh grid place-items-center bg-bg px-4 text-center">
        <div className="max-w-md">
          <p className="text-lg font-semibold text-ink">This page couldn't open</p>
          <p className="mt-1 text-base text-muted">Reload to try again. If it keeps happening, send a screenshot of this.</p>
          <p className="mt-3 rounded-md bg-inset px-3 py-2 text-left text-xs text-subtle [overflow-wrap:anywhere]">{error.message || String(error)}</p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => location.reload()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-base font-medium text-white hover:bg-accent-hover"
            >
              <RotateCcw size={14} /> Reload
            </button>
            <a href={`${import.meta.env.BASE_URL}#/`} className="inline-flex h-9 items-center rounded-md border border-border bg-surface px-3 text-base font-medium text-ink hover:bg-hover">
              Home
            </a>
          </div>
        </div>
      </div>
    );
  }
}
