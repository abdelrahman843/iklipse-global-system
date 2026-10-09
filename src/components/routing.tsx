import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { PageSpinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { ShieldAlert } from "lucide-react";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { ready, session, profile } = useAuth();
  const loc = useLocation();
  // Wait until the session and its profile are both resolved before deciding
  // where to send the user — a mid-hydrate render can otherwise misread a
  // still-loading profile as "deactivated".
  if (!ready) return <PageSpinner />;
  if (!session) return <Navigate to="/login" state={{ from: loc }} replace />;
  if (!profile?.is_active) {
    return <Navigate to="/login?state=deactivated" replace />;
  }
  return <>{children}</>;
}

/** Home: Trello if the person has it, else Miro. */
export function HomeRedirect() {
  const { trelloRole, miroRole } = useAuth();
  return <Navigate to={!trelloRole && miroRole ? "/wb" : "/pm/boards"} replace />;
}

/** Trello pages need a Trello role, Miro pages a Miro role (0044). */
export function ProductRoute({ kind, children }: { kind: "kanban" | "whiteboard"; children: React.ReactNode }) {
  const { trelloRole, miroRole } = useAuth();
  const ok = kind === "whiteboard" ? miroRole : trelloRole;
  if (!ok) {
    return (
      <EmptyState
        icon={<ShieldAlert size={28} />}
        title={kind === "whiteboard" ? "No access to Miro" : "No access to Trello"}
        description={`Your account doesn't include ${kind === "whiteboard" ? "Miro" : "Trello"}. Ask an admin if you need it.`}
      />
    );
  }
  return <>{children}</>;
}

export function AdminOnlyRoute({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) {
    return (
      <EmptyState
        icon={<ShieldAlert size={28} />}
        title="Admin only"
        description="You don't have permission to view this page. Contact an administrator if you believe this is a mistake."
      />
    );
  }
  return <>{children}</>;
}
