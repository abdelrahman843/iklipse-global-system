import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PermissionKey } from "@/lib/database.types";
import { useAuth } from "@/lib/auth";
import { boardCan, NO_ACCESS, type BoardAccessInfo } from "@/lib/permissions";
import { fetchBoardAccess } from "./boardApi";

export interface BoardAccessValue extends BoardAccessInfo {
  loading: boolean;
  can: (cap: PermissionKey) => boolean;
}

/** Caller's access on one board (server-computed: role + board settings). */
export function useBoardAccess(boardId: string | undefined): BoardAccessValue {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["board-access", boardId, user?.id],
    queryFn: () => fetchBoardAccess(boardId!),
    enabled: !!boardId && !!user,
    staleTime: 60_000,
  });
  const info = q.data ?? NO_ACCESS;
  return useMemo(
    () => ({ ...info, loading: q.isLoading, can: (cap: PermissionKey) => boardCan(info, cap) }),
    [info, q.isLoading],
  );
}

const Ctx = createContext<BoardAccessValue | null>(null);

export function BoardAccessProvider({ value, children }: { value: BoardAccessValue; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Board access from the enclosing board page. */
export function useCurrentBoardAccess(): BoardAccessValue {
  const v = useContext(Ctx);
  const { can } = useAuth();
  // Outside a board: fall back to workspace-level checks (admins only).
  return v ?? { ...NO_ACCESS, loading: false, can };
}

/** Drop-in for useAuth().can inside board screens. */
export function useBoardCan() {
  return useCurrentBoardAccess().can;
}
