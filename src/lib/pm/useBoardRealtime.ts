import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Subscribe to changes on a single board — cards, lists, labels, memberships,
 * comments. Every event invalidates the board bundle so the UI re-renders
 * against server truth.
 */
export function useBoardRealtime(boardId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!boardId) return;
    const bump = () => qc.invalidateQueries({ queryKey: ["board", boardId] });
    // Unique topic per hook instance — see the note in useNotificationsRealtime.
    const topic = `board:${boardId}:${Math.random().toString(36).slice(2, 10)}`;
    const ch = supabase
      .channel(topic)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "list", filter: `board_id=eq.${boardId}` },
        bump,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "card", filter: `board_id=eq.${boardId}` },
        bump,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "label", filter: `board_id=eq.${boardId}` },
        bump,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "board_member", filter: `board_id=eq.${boardId}` },
        bump,
      )
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [boardId, qc]);
}

export function useNotificationsRealtime(userId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    // Each hook instance owns its own channel — supabase-js dedupes on topic
    // and rejects a second `.on()` after `subscribe()`, which would break if
    // two components (the bell + the notifications page) both used
    // `notif:${userId}`.
    const topic = `notif:${userId}:${Math.random().toString(36).slice(2, 10)}`;
    const ch = supabase
      .channel(topic)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notification", filter: `user_id=eq.${userId}` },
        () => {
          qc.invalidateQueries({ queryKey: ["notifications"] });
          qc.invalidateQueries({ queryKey: ["notif-unread"] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [userId, qc]);
}
