import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { ActivityWithActor } from "@/components/pm/card/CommentsFeed";
import { fetchCardDetail, type BoardBundle, type CardDetailBundle } from "@/lib/pm/boardApi";

// Shared query definitions for the card modal, so the board can warm them
// (on hover) with exactly the keys the modal reads.

export const cardDetailQuery = (cardId: string) => ({
  queryKey: ["card", cardId] as const,
  queryFn: () => fetchCardDetail(cardId),
});

export const cardActivityQuery = (cardId: string) => ({
  queryKey: ["activity", cardId] as const,
  queryFn: async () => {
    const { data, error } = await supabase
      .from("activity")
      .select("*, actor:actor_id(id, display_name, avatar_url)")
      .eq("card_id", cardId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return (data ?? []) as ActivityWithActor[];
  },
});

const warmed = new Map<string, number>();

// Hover prefetch. Throttled per card so sweeping the mouse across a list
// doesn't refire requests for cards fetched a moment ago.
export function prefetchCard(qc: QueryClient, cardId: string) {
  const now = Date.now();
  if (now - (warmed.get(cardId) ?? 0) < 15_000) return;
  warmed.set(cardId, now);
  void qc.prefetchQuery({ ...cardDetailQuery(cardId), staleTime: 15_000 });
  void qc.prefetchQuery({ ...cardActivityQuery(cardId), staleTime: 15_000 });
}

// What the board already knows about a card — lets the modal paint its
// header, labels, members and dates instantly while the full bundle loads.
export function cardPlaceholder(qc: QueryClient, boardId: string, cardId: string): CardDetailBundle | undefined {
  const b = qc.getQueryData<BoardBundle>(["board", boardId]);
  const card = b?.cards.find((c) => c.id === cardId);
  if (!b || !card) return undefined;
  return {
    card,
    comments: [],
    checklists: [],
    items: [],
    attachments: [],
    labelIds: b.cardLabels.filter((r) => r.card_id === cardId).map((r) => r.label_id),
    memberIds: b.cardMembers.filter((r) => r.card_id === cardId).map((r) => r.user_id),
    reactions: [],
  };
}
