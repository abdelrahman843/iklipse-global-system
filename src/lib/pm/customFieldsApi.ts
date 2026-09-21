import { supabase } from "@/lib/supabase";

export type CustomFieldType = "text" | "number" | "date" | "checkbox" | "select";

export interface CustomFieldDef {
  id: string;
  board_id: string;
  name: string;
  type: CustomFieldType;
  options: { id: string; label: string; color?: string }[] | null;
  show_on_front: boolean;
  position: string;
}

export interface CustomFieldValue {
  card_id: string;
  field_id: string;
  value: unknown;
}

export async function listFields(boardId: string): Promise<CustomFieldDef[]> {
  const { data, error } = await supabase
    .from("custom_field_def")
    .select("*")
    .eq("board_id", boardId)
    .order("position");
  if (error) throw error;
  return (data ?? []) as CustomFieldDef[];
}

export async function createField(
  boardId: string,
  input: Partial<CustomFieldDef> & { name: string; type: CustomFieldType },
) {
  const { data: existing } = await supabase
    .from("custom_field_def")
    .select("position")
    .eq("board_id", boardId)
    .order("position", { ascending: false })
    .limit(1);
  const afterPos = (existing?.[0] as { position?: string } | undefined)?.position ?? null;
  // Simple monotonic string; DB doesn't enforce fractional-index for fields.
  const position = afterPos ? afterPos + "m" : "m";
  const { error } = await supabase.from("custom_field_def").insert({
    board_id: boardId,
    name: input.name,
    type: input.type,
    options: input.options ?? null,
    show_on_front: input.show_on_front ?? false,
    position,
  });
  if (error) throw error;
}

export async function deleteField(id: string) {
  const { error } = await supabase.from("custom_field_def").delete().eq("id", id);
  if (error) throw error;
}

export async function listCardValues(cardId: string): Promise<CustomFieldValue[]> {
  const { data, error } = await supabase
    .from("custom_field_value")
    .select("*")
    .eq("card_id", cardId);
  if (error) throw error;
  return (data ?? []) as CustomFieldValue[];
}

export async function setCardValue(cardId: string, fieldId: string, value: unknown) {
  if (value === null || value === undefined || value === "") {
    const { error } = await supabase
      .from("custom_field_value")
      .delete()
      .eq("card_id", cardId)
      .eq("field_id", fieldId);
    if (error) throw error;
    return;
  }
  const { error } = await supabase
    .from("custom_field_value")
    .upsert({ card_id: cardId, field_id: fieldId, value });
  if (error) throw error;
}
