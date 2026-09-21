import { supabase } from "@/lib/supabase";
import type { Card } from "@/lib/database.types";

export async function listCardTemplates(boardId: string): Promise<Card[]> {
  const { data, error } = await supabase
    .from("card")
    .select("*")
    .eq("board_id", boardId)
    .eq("is_template", true)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Card[];
}

export async function setCardTemplate(cardId: string, isTemplate: boolean) {
  const { error } = await supabase.rpc("set_card_template", {
    p_card: cardId,
    p_template: isTemplate,
  });
  if (error) throw error;
}

export async function cloneCardIntoList(
  sourceCardId: string,
  targetListId: string,
  afterPosition: string | null,
): Promise<string> {
  const { data, error } = await supabase.rpc("clone_card", {
    p_source_card: sourceCardId,
    p_target_list: targetListId,
    p_after_position: afterPosition,
  });
  if (error) throw error;
  return data as string;
}
