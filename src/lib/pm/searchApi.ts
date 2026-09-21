import { supabase } from "@/lib/supabase";

export interface SearchHit {
  card_id: string;
  board_id: string;
  board_title: string;
  list_id: string;
  list_title: string;
  title: string;
  description: string | null;
  due_date: string | null;
  rank: number;
}

export async function searchCards(q: string, limit = 50): Promise<SearchHit[]> {
  const { data, error } = await supabase.rpc("search_cards", { p_query: q, p_limit: limit });
  if (error) throw error;
  return (data ?? []) as SearchHit[];
}

export interface MyCard {
  card_id: string;
  board_id: string;
  board_title: string;
  list_id: string;
  list_title: string;
  title: string;
  due_date: string | null;
  due_completed: boolean;
}

export async function myCards(): Promise<MyCard[]> {
  const { data, error } = await supabase.rpc("my_cards");
  if (error) throw error;
  return (data ?? []) as MyCard[];
}
