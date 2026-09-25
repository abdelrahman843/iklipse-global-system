import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { BoardBundle, CardDetailBundle } from "@/lib/pm/boardApi";

// -----------------------------------------------------------------------------
// Realtime wiring. Two Supabase rules shape everything here:
//  1. Filters only work on a column of the changed row — hence the
//     denormalised board_id / card_id columns (migrations 0011, 0016).
//  2. DELETE events ignore filters and, with RLS on, carry only the primary
//     key. So deletes get an unfiltered listener that checks the key against
//     what this screen currently shows.
// Every handler just invalidates queries; the UI re-renders from server truth.
// -----------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Payload = RealtimePostgresChangesPayload<Row>;

/** Unique topic per hook instance: supabase-js dedupes channels by topic and
 *  rejects `.on()` after `subscribe()`, which breaks when two components
 *  subscribe to the same thing. */
const topic = (name: string) => `${name}:${Math.random().toString(36).slice(2, 10)}`;

function listen(ch: RealtimeChannel, table: string, filter: string | null, fn: (p: Payload) => void) {
  return ch.on(
    "postgres_changes",
    filter ? { event: "*", schema: "public", table, filter } : { event: "*", schema: "public", table },
    fn,
  );
}

function listenDeletes(ch: RealtimeChannel, table: string, fn: (old: Row) => void) {
  return ch.on("postgres_changes", { event: "DELETE", schema: "public", table }, (p: Payload) =>
    fn((p.old ?? {}) as Row),
  );
}

const inv = (qc: QueryClient, ...keys: unknown[][]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));

/**
 * Everything on one board: board settings, lists, cards, labels, card chips
 * (labels/members), memberships, custom field definitions, automation.
 */
export function useBoardRealtime(boardId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!boardId) return;
    const f = `board_id=eq.${boardId}`;
    const bundle = () => qc.getQueryData<BoardBundle>(["board", boardId]);
    const bump = () => inv(qc, ["board", boardId]);
    const bumpContent = () => inv(qc, ["board", boardId], ["archived-cards", boardId], ["archived-lists", boardId]);
    const bumpAccess = () =>
      inv(qc, ["board", boardId], ["board-access", boardId], ["board-members", boardId], ["boards"]);

    const ch = supabase.channel(topic(`board:${boardId}`));
    listen(ch, "board", `id=eq.${boardId}`, bumpAccess); // rename, visibility, policies
    listen(ch, "list", f, bumpContent);
    listen(ch, "card", f, bumpContent);
    listen(ch, "label", f, bump);
    listen(ch, "card_label", f, bump);
    listen(ch, "card_member", f, bump);
    listen(ch, "board_member", f, bumpAccess);
    listen(ch, "custom_field_def", f, () => inv(qc, ["custom_field_def", boardId], ["board", boardId]));
    listen(ch, "automation_rule", f, () => inv(qc, ["rules", boardId]));
    listen(ch, "automation_run", f, () => inv(qc, ["rule-runs", boardId]));

    // Deletes (key-only, unfiltered) — act only when the row is on this board.
    const hasCard = (id: unknown) => !!bundle()?.cards.some((c) => c.id === id);
    listenDeletes(ch, "card", (o) => hasCard(o.id) && bumpContent());
    listenDeletes(ch, "list", (o) => bundle()?.lists.some((l) => l.id === o.id) && bumpContent());
    listenDeletes(ch, "label", (o) => bundle()?.labels.some((l) => l.id === o.id) && bump());
    listenDeletes(ch, "card_label", (o) => hasCard(o.card_id) && bump());
    listenDeletes(ch, "card_member", (o) => hasCard(o.card_id) && bump());
    listenDeletes(ch, "board_member", (o) => o.board_id === boardId && bumpAccess());
    listenDeletes(ch, "board", (o) => o.id === boardId && bumpAccess());
    ch.subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [boardId, qc]);
}

/** One open card: comments, reactions, checklists, attachments, fields. */
export function useCardRealtime(cardId: string, boardId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    const f = `card_id=eq.${cardId}`;
    const bundle = () => qc.getQueryData<CardDetailBundle>(["card", cardId]);
    const bump = () => inv(qc, ["card", cardId]);
    const bumpWithActivity = () => inv(qc, ["card", cardId], ["activity", cardId]);
    // Checklist progress and attachment counts also show on the board's card chips.
    const bumpWithBoard = () => inv(qc, ["card", cardId], ["board", boardId]);

    const ch = supabase.channel(topic(`card:${cardId}`));
    listen(ch, "card", `id=eq.${cardId}`, bump);
    listen(ch, "comment", f, bumpWithActivity);
    listen(ch, "comment_reaction", f, bump);
    listen(ch, "card_member", f, bump);
    listen(ch, "card_label", f, bump);
    listen(ch, "checklist", f, bumpWithBoard);
    listen(ch, "checklist_item", f, bumpWithBoard);
    listen(ch, "attachment", f, bumpWithBoard);
    listen(ch, "custom_field_value", f, () => inv(qc, ["custom_field_value", cardId]));
    listen(ch, "activity", f, () => inv(qc, ["activity", cardId]));

    const b = bundle;
    listenDeletes(ch, "comment", (o) => b()?.comments.some((c) => c.id === o.id) && bumpWithActivity());
    listenDeletes(ch, "comment_reaction", (o) => b()?.comments.some((c) => c.id === o.comment_id) && bump());
    listenDeletes(ch, "checklist", (o) => b()?.checklists.some((c) => c.id === o.id) && bumpWithBoard());
    listenDeletes(ch, "checklist_item", (o) => b()?.items.some((i) => i.id === o.id) && bumpWithBoard());
    listenDeletes(ch, "attachment", (o) => b()?.attachments.some((a) => a.id === o.id) && bumpWithBoard());
    listenDeletes(ch, "card_label", (o) => o.card_id === cardId && bump());
    listenDeletes(ch, "card_member", (o) => o.card_id === cardId && bump());
    listenDeletes(ch, "custom_field_value", (o) => o.card_id === cardId && inv(qc, ["custom_field_value", cardId]));
    ch.subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [cardId, boardId, qc]);
}

/** Boards home: new boards, renames, being added to / removed from a board. */
export function useBoardsListRealtime(userId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    const bump = () => inv(qc, ["boards"]);
    const ch = supabase.channel(topic(`boards:${userId}`));
    listen(ch, "board", null, bump); // RLS limits this to boards I can see
    listen(ch, "board_member", `user_id=eq.${userId}`, bump);
    listenDeletes(ch, "board_member", (o) => o.user_id === userId && bump());
    listenDeletes(ch, "board", bump);
    ch.subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [userId, qc]);
}

/** Admin users page: profiles and board memberships. */
export function useUsersRealtime(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const bump = () => inv(qc, ["users"]);
    const ch = supabase.channel(topic("users"));
    listen(ch, "profile", null, bump);
    listen(ch, "board_member", null, bump);
    ch.subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [enabled, qc]);
}

export function useNotificationsRealtime(userId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    const ch = supabase.channel(topic(`notif:${userId}`));
    listen(ch, "notification", `user_id=eq.${userId}`, () => inv(qc, ["notifications"], ["notif-unread"]));
    ch.subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [userId, qc]);
}
