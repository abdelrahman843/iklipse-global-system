import type { QueryClient } from "@tanstack/react-query";
import { readStoredSession, supabase } from "@/lib/supabase";
import type { BoardAccessInfo } from "@/lib/permissions";
import {
  fetchBoardAccess,
  fetchBoardBundle,
  fetchBoardCardDetails,
  listBoards,
  type BoardBundle,
  type BoardSummary,
} from "@/lib/pm/boardApi";
import { fetchComments, fetchWbBoard } from "@/lib/wb/api";
import { getOne, putOne } from "./idb";
import { isOnline, onConnectivity } from "./net";
import { whenSent } from "./outbox";
import { saveWbSnapshot, wbSnapshotAge } from "./wbCache";

// -----------------------------------------------------------------------------
// Getting ready for offline. A while after the app starts, and every 20 minutes
// while it's open and online, the boards the person can open are loaded in the
// background (one at a time, gently): each Trello board with every card's
// details, and each Miro board's canvas. They land in the offline copy, so the
// whole workspace opens with no network, not just the screens seen before.
// Skipped on a metered "data saver" connection, except the boards themselves.
// -----------------------------------------------------------------------------

const FIRST_RUN_MS = 6000;
const EVERY_MS = 20 * 60_000;
/** Re-read a board when something happened on it since, or at least this often. */
const BUNDLE_MAX_AGE_MS = 3 * 60 * 60_000;
const CARDS_MAX_AGE_MS = 12 * 60 * 60_000;
const ACCESS_FRESH_MS = 60 * 60_000;
const CANVAS_FRESH_MS = 30 * 60_000;
const MAX_KANBAN = 40;
const MAX_WB = 20;

interface CardPacks {
  owner: string;
  at: Record<string, number>;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const saveData = () => (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
const stillMe = (uid: string) => isOnline() && readStoredSession()?.user.id === uid;

async function canvasRows(boardId: string) {
  const out: unknown[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("wb_item")
      .select("*")
      .eq("board_id", boardId)
      .order("z")
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

/** When the board last changed (its newest history entry), or 0. */
async function lastChange(boardId: string): Promise<number> {
  const { data } = await supabase
    .from("activity")
    .select("created_at")
    .eq("board_id", boardId)
    .order("created_at", { ascending: false })
    .limit(1);
  const at = (data?.[0] as { created_at?: string } | undefined)?.created_at;
  return at ? Date.parse(at) : 0;
}

/** Members first, then the most recently changed. */
const byInterest = (a: BoardSummary, b: BoardSummary) =>
  Number(!!b.my_role) - Number(!!a.my_role) || (b.updated_at ?? "").localeCompare(a.updated_at ?? "");

async function warm(qc: QueryClient, uid: string) {
  // Changes made offline go up first, so what comes down includes them.
  await whenSent(15_000);
  const boards = await qc.fetchQuery({ queryKey: ["boards", uid], queryFn: () => listBoards(uid), staleTime: 60_000 });
  const kanban = boards.filter((b) => b.kind !== "whiteboard").sort(byInterest).slice(0, MAX_KANBAN);
  const canvases = boards.filter((b) => b.kind === "whiteboard").sort(byInterest).slice(0, MAX_WB);
  const light = saveData();

  const packs = (await getOne<CardPacks>("meta", "card-packs").catch(() => undefined)) ?? { owner: uid, at: {} };
  if (packs.owner !== uid) packs.at = {};
  packs.owner = uid;

  for (const b of kanban) {
    if (!stillMe(uid)) return;
    try {
      await qc.prefetchQuery({ queryKey: ["board-access", b.id, uid], queryFn: () => fetchBoardAccess(b.id), staleTime: ACCESS_FRESH_MS });
      if (!qc.getQueryData<BoardAccessInfo>(["board-access", b.id, uid])?.access) continue;
      // One small request tells whether anything changed since the copy was made.
      const changed = await lastChange(b.id);
      const had = qc.getQueryState(["board", b.id]);
      const bundleStale = !had?.data || had.dataUpdatedAt < changed || Date.now() - had.dataUpdatedAt > BUNDLE_MAX_AGE_MS;
      if (bundleStale) await qc.prefetchQuery({ queryKey: ["board", b.id], queryFn: () => fetchBoardBundle(b.id), staleTime: 0 });
      const bundle = qc.getQueryData<BoardBundle>(["board", b.id]);
      const packAt = packs.at[b.id] ?? 0;
      if (!bundle || light || (packAt >= changed && Date.now() - packAt < CARDS_MAX_AGE_MS)) continue;
      const at = Date.now();
      const details = await fetchBoardCardDetails(bundle);
      if (!stillMe(uid)) return;
      for (const [id, d] of details) {
        // A card opened recently has fuller data (history authors): keep it.
        const st = qc.getQueryState(["card", id]);
        if (st?.data !== undefined && st.dataUpdatedAt > Math.max(changed, at - CARDS_MAX_AGE_MS)) continue;
        qc.setQueryData(["card", id], d, { updatedAt: at });
      }
      packs.at[b.id] = at;
      await putOne("meta", "card-packs", packs).catch(() => undefined);
    } catch {
      /* this board another time */
    }
    await pause(300);
  }

  if (light) return;
  for (const b of canvases) {
    if (!stillMe(uid)) return;
    try {
      await qc.prefetchQuery({ queryKey: ["board-access", b.id, uid], queryFn: () => fetchBoardAccess(b.id), staleTime: ACCESS_FRESH_MS });
      if (!qc.getQueryData<BoardAccessInfo>(["board-access", b.id, uid])?.access) continue;
      await qc.prefetchQuery({ queryKey: ["wb-board", b.id], queryFn: () => fetchWbBoard(b.id), staleTime: CANVAS_FRESH_MS });
      await qc.prefetchQuery({ queryKey: ["wb-comments", b.id], queryFn: () => fetchComments(b.id), staleTime: CANVAS_FRESH_MS });
      // The board open on screen keeps its own copy up to date.
      if (location.hash.includes(`/wb/${b.id}`)) continue;
      const age = await wbSnapshotAge(b.id);
      if (age !== null && age < CANVAS_FRESH_MS) continue;
      const rows = await canvasRows(b.id);
      if (!stillMe(uid)) return;
      await saveWbSnapshot(b.id, rows, uid);
    } catch {
      /* this board another time */
    }
    await pause(300);
  }
}

let running = false;
let lastRun = 0;

export function startOfflinePrefetch(qc: QueryClient) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const plan = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), ms);
  };
  const run = async () => {
    plan(EVERY_MS);
    const uid = readStoredSession()?.user.id;
    if (running || !uid || !isOnline() || document.visibilityState === "hidden") return;
    running = true;
    lastRun = Date.now();
    try {
      await warm(qc, uid);
    } catch {
      /* next round */
    } finally {
      running = false;
    }
  };
  plan(FIRST_RUN_MS);
  // Back online: catch up once the reconnect has settled.
  onConnectivity((online) => online && plan(10_000));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastRun > EVERY_MS) plan(3000);
  });
}
