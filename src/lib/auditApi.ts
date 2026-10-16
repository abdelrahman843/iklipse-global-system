import { supabase } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// The activity log (0073): who made, changed or deleted what, and when, across
// iklipse. Admins only. Bots, syncs and timers are left out; a client's
// comments and feedback on a delivery are in, under their name.
// -----------------------------------------------------------------------------

export type AuditArea = "trello" | "miro" | "projects" | "deliveries" | "users" | "alerts" | "briefs" | "invoices" | "sharing" | "workspace";

export interface AuditRow {
  id: number;
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_avatar: string | null;
  action: "create" | "edit" | "delete";
  area: AuditArea;
  entity: string;
  row_id: string | null;
  label: string | null;
  ref: {
    board_id?: string;
    card_id?: string;
    project_id?: string;
    folder_id?: string;
    kind?: string;
    board?: string;
    card?: string;
    project?: string;
    folder?: string;
    person?: string;
    label_name?: string;
  };
  /** edit: { column: [before, after] }; create / delete: the row. */
  changes: Record<string, unknown> | null;
}

export const AREAS: { value: AuditArea; label: string }[] = [
  { value: "trello", label: "Trello" },
  { value: "miro", label: "Miro" },
  { value: "projects", label: "Projects" },
  { value: "deliveries", label: "Deliveries" },
  { value: "alerts", label: "Alerts" },
  { value: "users", label: "Users" },
  { value: "briefs", label: "Briefs" },
  { value: "invoices", label: "Invoices" },
  { value: "sharing", label: "Sharing" },
  { value: "workspace", label: "Workspace" },
];

export const PAGE = 100;

export async function fetchAudit(o: { before?: string | null; area?: string | null; actor?: string | null; q?: string | null }): Promise<AuditRow[]> {
  const { data, error } = await supabase.rpc("audit_log_page" as never, {
    p_before: o.before ?? null,
    p_area: o.area || null,
    p_actor: o.actor || null,
    p_q: o.q?.trim() || null,
    p_limit: PAGE,
  } as never);
  if (error) throw new Error((error as { message: string }).message);
  return (data ?? []) as unknown as AuditRow[];
}
