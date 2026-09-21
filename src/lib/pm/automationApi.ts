import { supabase } from "@/lib/supabase";

export interface AutomationTrigger {
  kind: "card.created" | "card.moved" | "card.archived" | "card.due_completed";
  filter?: { checks: AutomationCondition[] };
}
export interface AutomationCondition {
  kind: "has_label" | "has_member" | "in_list" | "due_incomplete";
  args?: Record<string, string>;
}
export interface AutomationAction {
  kind:
    | "move_to_list"
    | "archive"
    | "restore"
    | "complete_due"
    | "add_label"
    | "remove_label"
    | "add_member"
    | "remove_member"
    | "add_comment"
    | "rename"
    | "set_description";
  args?: Record<string, string>;
}
export interface AutomationRule {
  id: string;
  board_id: string;
  name: string;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  is_enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}
export interface AutomationRun {
  id: string;
  rule_id: string;
  board_id: string;
  card_id: string | null;
  actor_id: string | null;
  status: "ok" | "skipped" | "error";
  detail: unknown;
  depth: number;
  created_at: string;
}

export async function listRules(boardId: string): Promise<AutomationRule[]> {
  const { data, error } = await supabase
    .from("automation_rule")
    .select("*")
    .eq("board_id", boardId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AutomationRule[];
}

export async function upsertRule(rule: Partial<AutomationRule> & { board_id: string; name: string; trigger: AutomationTrigger }) {
  const payload = {
    ...rule,
    conditions: rule.conditions ?? [],
    actions: rule.actions ?? [],
    is_enabled: rule.is_enabled ?? true,
  };
  if (rule.id) {
    const { error } = await supabase
      .from("automation_rule")
      .update(payload)
      .eq("id", rule.id);
    if (error) throw error;
    return rule.id;
  }
  const { data: u } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("automation_rule")
    .insert({ ...payload, created_by: u.user?.id })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function deleteRule(id: string) {
  const { error } = await supabase.from("automation_rule").delete().eq("id", id);
  if (error) throw error;
}

export async function toggleRule(id: string, enabled: boolean) {
  const { error } = await supabase
    .from("automation_rule")
    .update({ is_enabled: enabled })
    .eq("id", id);
  if (error) throw error;
}

export async function recentRuns(boardId: string, limit = 30): Promise<AutomationRun[]> {
  const { data, error } = await supabase
    .from("automation_run")
    .select("*")
    .eq("board_id", boardId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AutomationRun[];
}
