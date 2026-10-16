import { supabase } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// The activity log (0073, 0074): who made, changed or deleted what, and when,
// across iklipse. Admins only. Bots, syncs and timers are left out; a client's
// comments and feedback on a delivery are in, under their name.
// A page can be narrowed by part of iklipse, person, words, action, type of
// thing and a time window. Each row brings `names`: every id it mentions,
// mapped to a readable name (an id missing from it points at something deleted).
// -----------------------------------------------------------------------------

export type AuditArea = "trello" | "miro" | "projects" | "deliveries" | "users" | "alerts" | "briefs" | "invoices" | "sharing" | "workspace";
export type AuditAction = "create" | "edit" | "delete";

export interface AuditRow {
  id: number;
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_avatar: string | null;
  action: AuditAction;
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
  /** edit: { column: [before, after] }; create / delete: { column: value }. */
  changes: Record<string, unknown> | null;
  /** Every uuid in changes, row_id and ref, mapped to a readable name. Missing = deleted. */
  names: Record<string, string>;
}

/** One kind of thing in the log, for the Type filter. */
export interface AuditEntity {
  area: AuditArea;
  entity: string;
  n: number;
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

export interface AuditFilters {
  area?: string | null;
  actor?: string | null;
  q?: string | null;
  action?: string | null;
  entity?: string | null;
  /** ISO timestamps: at >= from, at < to. */
  from?: string | null;
  to?: string | null;
}

export async function fetchAudit(o: AuditFilters & { before?: string | null }): Promise<AuditRow[]> {
  const { data, error } = await supabase.rpc("audit_log_page" as never, {
    p_before: o.before ?? null,
    p_area: o.area || null,
    p_actor: o.actor || null,
    p_q: o.q?.trim() || null,
    p_limit: PAGE,
    p_action: o.action || null,
    p_entity: o.entity || null,
    p_from: o.from || null,
    p_to: o.to || null,
  } as never);
  if (error) throw new Error((error as { message: string }).message);
  // ref and names are always objects on screen, even from an older reader.
  return ((data ?? []) as unknown as AuditRow[]).map((r) => ({ ...r, ref: r.ref ?? {}, names: r.names ?? {} }));
}

export async function fetchAuditEntities(): Promise<AuditEntity[]> {
  const { data, error } = await supabase.rpc("audit_log_entities" as never);
  if (error) throw new Error((error as { message: string }).message);
  return (data ?? []) as unknown as AuditEntity[];
}
