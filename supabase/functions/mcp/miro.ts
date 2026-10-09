// Miro side of the MCP: whiteboards, what's on them, sharing, comments.
// Items are the same rows the app draws (public.wb_item), so they show up live
// for everyone on the board.

import {
  actions, bool, boardOf, boardUrl, changed, must, num, ok, oneOf, optNum, optStr, person, str, uuid, UserError, type Args, type Ctx, type Tool,
} from "./lib.ts";
import { COLORS } from "./trello.ts";

const WB_ROLES = ["coowner", "editor", "commenter", "viewer"] as const;
const BOARD_ROLE: Record<string, string> = { owner: "admin", coowner: "admin", editor: "normal", commenter: "observer", viewer: "observer" };
const fill = (v: unknown, fallback: string) => {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "string" && COLORS[v]) return COLORS[v]!;
  if (v === "white" || v === "surface") return "surface";
  if (v === "black" || v === "ink") return "ink";
  throw new UserError(`color must be one of: ${Object.keys(COLORS).join(", ")}, white, black`);
};
const colorName = (hex: unknown) => (typeof hex === "string" ? Object.entries(COLORS).find(([, v]) => v === hex)?.[0] ?? hex : undefined);

type Item = { id: string; type: string; x: number; y: number; w: number; h: number; z: number; frame_id: string | null; data: Record<string, unknown> };

const textOf = (it: { type: string; data: Record<string, unknown> }) => {
  const d = it.data;
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
  if (it.type === "card" || it.type === "doc" || it.type === "frame") return s("title");
  if (it.type === "embed") return s("name") || s("url");
  if (it.type === "image") return s("name");
  if (it.type === "emoji") return s("emoji");
  if (it.type === "connector") return s("label");
  return s("text");
};

/** Rough text box size (the app measures exactly when it renders). */
function textSize(text: string, size: number, maxW = 640) {
  const lines = text.split("\n");
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const w = Math.min(maxW, Math.max(40, Math.ceil(longest * size * 0.56) + 8));
  const perLine = Math.max(1, Math.floor(w / (size * 0.56)));
  const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  return { w, h: Math.ceil(rows * size * 1.4) };
}

function embedSize(url: string) {
  if (/instagram\.com\/(p|reel|reels|tv)\/|tiktok\.com\/.+\/video\/|youtube\.com\/shorts\//i.test(url)) return { w: 340, h: 640 };
  if (/youtube\.com|youtu\.be|vimeo\.com|facebook\.com|fb\.watch|loom\.com|drive\.google\.com|pinterest\./i.test(url)) return { w: 560, h: 352 };
  if (/docs\.google\.com/i.test(url)) return { w: 560, h: 720 };
  return { w: 360, h: 112 };
}

async function items(c: Ctx, boardId: string): Promise<Item[]> {
  return must(await c.db.from("wb_item").select("id, type, x, y, w, h, z, frame_id, data").eq("board_id", boardId).limit(10000), "Items") as Item[];
}

// ------------------------------------------------------------------- read --
export const miroRead: Tool[] = [
  {
    name: "get_miro_board",
    title: "Get a Miro board",
    description:
      "Everything on a Miro board with ids, positions (x, y, w, h in board units) and colors: frames and what's in each, sticky notes, text, shapes, cards, docs, links/videos, images, connectors, plus comment threads. Use it before adding or moving things so new items don't overlap.",
    inputSchema: {
      type: "object",
      properties: { board_id: { type: "string" }, include_resolved: { type: "boolean", description: "Also resolved comment threads." } },
      required: ["board_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, c) => {
      const b = await boardOf(c, uuid(a.board_id, "board_id"), "whiteboard");
      const all = await items(c, b.id);
      const [board, members, comments] = await Promise.all([
        c.db.from("board").select("wb_team_access, wb_allow_copy, visibility").eq("id", b.id).single(),
        c.db.from("board_member").select("wb_role, profile:user_id(id, display_name, username)").eq("board_id", b.id),
        c.db.from("wb_comment").select("id, thread_id, item_id, body, resolved, guest_name, created_at, author:author_id(display_name)").eq("board_id", b.id).order("created_at"),
      ]);
      const r = (n: number) => Math.round(n);
      const view = (i: Item) => {
        const d = i.data;
        const out: Record<string, unknown> = { id: i.id, type: i.type === "embed" ? (d.path ? "video" : "link") : i.type, text: textOf(i).slice(0, 1500) || undefined, x: r(i.x), y: r(i.y), w: r(i.w), h: r(i.h) };
        if (i.type === "sticky" || i.type === "shape" || i.type === "card") out.color = colorName(d.fill);
        if (i.type === "shape") out.shape = d.shape;
        if (i.type === "doc" && Array.isArray(d.blocks)) out.doc_preview = (d.blocks as { x?: string }[]).map((x) => x.x ?? "").filter(Boolean).join("\n").slice(0, 1500);
        if (i.type === "embed" && d.url) out.url = d.url;
        return out;
      };
      const frames = all.filter((i) => i.type === "frame").sort((x, y) => (Number(x.data.order ?? 1e9) - Number(y.data.order ?? 1e9)) || x.y - y.y || x.x - y.x);
      const shown = all.filter((i) => i.type !== "frame" && i.type !== "connector" && i.type !== "pen");
      const coms = must(comments, "Comments") as { id: string; thread_id: string | null; item_id: string | null; body: string; resolved: boolean; guest_name: string | null; created_at: string; author: { display_name: string } | null }[];
      const by = (m: (typeof coms)[number]) => m.author?.display_name ?? (m.guest_name ? `${m.guest_name} (guest)` : undefined);
      return {
        board: { id: b.id, title: b.title, url: boardUrl(c, b), ...(must(board, "Board") as object) },
        members: (must(members, "Members") as { wb_role: string; profile: { id: string; display_name: string; username: string } | null }[]).map((m) => ({ ...m.profile, role: m.wb_role })),
        frames: frames.map((f) => ({ ...view(f), title: textOf(f) || "Frame", items: shown.filter((i) => i.frame_id === f.id).map(view) })),
        outside_frames: shown.filter((i) => !i.frame_id || !frames.some((f) => f.id === i.frame_id)).map(view),
        connectors: all.filter((i) => i.type === "connector").map((i) => {
          const d = i.data as { start?: { id?: string }; end?: { id?: string }; label?: string };
          return { id: i.id, from: d.start?.id ?? undefined, to: d.end?.id ?? undefined, label: d.label || undefined };
        }),
        drawings: all.filter((i) => i.type === "pen").length || undefined,
        comment_threads: coms
          .filter((t) => !t.thread_id && (a.include_resolved === true || !t.resolved))
          .map((t) => ({ thread_id: t.id, on_item: t.item_id ?? undefined, resolved: t.resolved || undefined, by: by(t), text: t.body, replies: coms.filter((x) => x.thread_id === t.id).map((x) => ({ id: x.id, by: by(x), text: x.body })) })),
      };
    },
  },
];

// ------------------------------------------------------------------ write --
const W = { readOnlyHint: false, openWorldHint: false } as const;

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    ref: { type: "string", description: "Your own name for this item, so later items can use it as frame / from / to." },
    type: { type: "string", enum: ["sticky", "text", "shape", "frame", "card", "link", "emoji", "connector"] },
    text: { type: "string", description: "Sticky, text and shape text; frame and card title; connector label." },
    description: { type: "string", description: "Card description." },
    x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
    color: { type: "string", description: `${Object.keys(COLORS).join(", ")}, white or black` },
    shape: { type: "string", enum: ["rect", "round", "ellipse", "triangle", "diamond", "hexagon", "star", "arrow_right", "callout", "cylinder"] },
    font_size: { type: "number" }, bold: { type: "boolean" },
    frame: { type: "string", description: "Frame id or ref to put it in. Its x / y are then relative to the frame's top-left." },
    url: { type: "string", description: "Link or video (type link)." },
    emoji: { type: "string" },
    from: { type: "string", description: "Connector start: item id or ref." },
    to: { type: "string", description: "Connector end: item id or ref." },
  },
  required: ["type"],
  additionalProperties: false,
};

export const miroWrite: Tool[] = [
  {
    name: "miro_board",
    title: "Manage a Miro board",
    description:
      "Miro board actions. create {title}; rename {board_id, title}; delete {board_id} (permanent, ask first); add_member / set_role {board_id, user, role: coowner|editor|commenter|viewer}; remove_member {board_id, user}; transfer_owner {board_id, user}; set_team_access {board_id, access: none|view|comment|edit} (what the whole workspace gets); set_allow_copy {board_id, allow}; share links for clients without an account: create_link {board_id, access: view|comment, expires_in_days?, max_devices?, label?} -> url; list_links {board_id}; link_off / link_on / delete_link {link_id}.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "rename", "delete", "add_member", "set_role", "remove_member", "transfer_owner", "set_team_access", "set_allow_copy", "create_link", "list_links", "link_off", "link_on", "delete_link"] },
        board_id: { type: "string" }, title: { type: "string" }, user: { type: "string" },
        role: { type: "string", enum: [...WB_ROLES] }, access: { type: "string", enum: ["none", "view", "comment", "edit"] },
        allow: { type: "boolean" }, expires_in_days: { type: "number" }, max_devices: { type: "integer", minimum: 1, maximum: 1000 },
        label: { type: "string" }, link_id: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { ...W, destructiveHint: true },
    run: (a, c) => {
      const board = () => boardOf(c, uuid(a.board_id, "board_id"), "whiteboard");
      return actions(a, {
        create: async () => {
          const id = must(await c.db.rpc("create_board", { p_title: str(a.title, "title", 200), p_description: null, p_background: null, p_visibility: "workspace", p_kind: "whiteboard" }), "Create board") as string;
          return { board_id: id, url: boardUrl(c, { id, kind: "whiteboard" }) };
        },
        rename: async () => {
          const b = await board();
          await changed(c.db.from("board").update({ title: str(a.title, "title", 200) }).eq("id", b.id).select("id"), "Rename board");
          return { board_id: b.id };
        },
        delete: async () => {
          const b = await board();
          await changed(c.db.from("board").delete().eq("id", b.id).select("id"), "Delete board");
          return { deleted: b.title };
        },
        add_member: async () => {
          const b = await board();
          const p = await person(c, a.user);
          const role = oneOf(a.role ?? "editor", "role", WB_ROLES);
          await ok(c.db.from("board_member").insert({ board_id: b.id, user_id: p.id, role: BOARD_ROLE[role], wb_role: role }), "Add member");
          return { board: b.title, added: p.display_name, role };
        },
        set_role: async () => {
          const b = await board();
          const p = await person(c, a.user);
          const role = oneOf(a.role, "role", WB_ROLES);
          await changed(c.db.from("board_member").update({ wb_role: role, role: BOARD_ROLE[role] }).eq("board_id", b.id).eq("user_id", p.id).select("user_id"), "Set role");
          return { board: b.title, user: p.display_name, role };
        },
        remove_member: async () => {
          const b = await board();
          const p = await person(c, a.user);
          await changed(c.db.from("board_member").delete().eq("board_id", b.id).eq("user_id", p.id).select("user_id"), "Remove member");
          return { board: b.title, removed: p.display_name };
        },
        transfer_owner: async () => {
          const b = await board();
          const p = await person(c, a.user);
          await ok(c.db.rpc("wb_transfer_ownership", { p_board: b.id, p_user: p.id }), "Transfer ownership");
          return { board: b.title, new_owner: p.display_name };
        },
        set_team_access: async () => {
          const b = await board();
          await changed(c.db.from("board").update({ wb_team_access: oneOf(a.access, "access", ["none", "view", "comment", "edit"] as const) }).eq("id", b.id).select("id"), "Team access");
          return { board: b.title, team_access: a.access };
        },
        set_allow_copy: async () => {
          const b = await board();
          await changed(c.db.from("board").update({ wb_allow_copy: a.allow !== false }).eq("id", b.id).select("id"), "Allow copy");
          return { board: b.title, allow_copy: a.allow !== false };
        },
        create_link: async () => {
          const b = await board();
          const days = optNum(a.expires_in_days, "expires_in_days");
          const max = optNum(a.max_devices, "max_devices");
          const l = must(await c.db.from("wb_share_link").insert({
            board_id: b.id, access: oneOf(a.access ?? "view", "access", ["view", "comment"] as const), label: optStr(a.label, 80) ?? null,
            expires_at: days ? new Date(Date.now() + days * 86400_000).toISOString() : null, max_devices: max ? Math.round(max) : null,
          }).select("id, token, expires_at, max_devices, access").single(), "Create link") as { id: string; token: string; expires_at: string | null; max_devices: number | null; access: string };
          return { link_id: l.id, url: `${c.appUrl}/#/s/${l.token}`, access: l.access, expires_at: l.expires_at ?? "never", max_devices: l.max_devices ?? "any" };
        },
        list_links: async () => {
          const b = await board();
          const links = must(await c.db.from("wb_share_link").select("id, token, label, access, expires_at, max_devices, revoked_at, created_at").eq("board_id", b.id).order("created_at", { ascending: false }), "Links") as {
            id: string; token: string; label: string | null; access: string; expires_at: string | null; max_devices: number | null; revoked_at: string | null; created_at: string;
          }[];
          const devs = links.length ? (must(await c.db.from("wb_share_device").select("link_id, name, last_seen").in("link_id", links.map((l) => l.id)), "Devices") as { link_id: string; name: string | null; last_seen: string }[]) : [];
          return links.map((l) => ({
            link_id: l.id, label: l.label ?? undefined, url: `${c.appUrl}/#/s/${l.token}`, access: l.access, on: !l.revoked_at,
            expires_at: l.expires_at ?? "never", max_devices: l.max_devices ?? "any",
            devices: devs.filter((d) => d.link_id === l.id).map((d) => ({ name: d.name ?? "Unnamed", last_seen: d.last_seen })),
          }));
        },
        link_off: async () => {
          const id = uuid(a.link_id, "link_id");
          await changed(c.db.from("wb_share_link").update({ revoked_at: new Date().toISOString() }).eq("id", id).select("id"), "Turn off link");
          return { link_id: id, on: false };
        },
        link_on: async () => {
          const id = uuid(a.link_id, "link_id");
          await changed(c.db.from("wb_share_link").update({ revoked_at: null }).eq("id", id).select("id"), "Turn on link");
          return { link_id: id, on: true };
        },
        delete_link: async () => {
          const id = uuid(a.link_id, "link_id");
          await changed(c.db.from("wb_share_link").delete().eq("id", id).select("id"), "Delete link");
          return { deleted_link: id };
        },
      });
    },
  },
  {
    name: "miro_items",
    title: "Add, change or remove things on a Miro board",
    description:
      "Build on a Miro board. add {board_id, items: [...]}: sticky notes, text, shapes, frames, cards, links/videos, stamps (emoji) and connectors, in order; give items a ref to put later ones in a frame or connect them (from / to). Without x / y things are placed next to what's there (or in a grid inside their frame). Board units: a sticky is 200x200, a 16:9 frame 1280x720. update {board_id, items: [{id, text?, x?, y?, w?, h?, color?, frame?: id or none, description?}]}; delete {board_id, ids: [...]} (ask first for many). Read get_miro_board first to see what's there.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "update", "delete"] },
        board_id: { type: "string" },
        items: { type: "array", items: { ...ITEM_SCHEMA, properties: { ...ITEM_SCHEMA.properties, id: { type: "string" } }, required: [] }, maxItems: 200 },
        ids: { type: "array", items: { type: "string" }, maxItems: 500 },
      },
      required: ["action", "board_id"],
      additionalProperties: false,
    },
    annotations: { ...W, destructiveHint: true },
    run: (a, c) =>
      actions(a, {
        add: async () => {
          const b = await boardOf(c, uuid(a.board_id, "board_id"), "whiteboard");
          const list = Array.isArray(a.items) ? (a.items as Args[]) : [];
          if (!list.length) throw new UserError("items is empty");
          const existing = await items(c, b.id);
          let z = existing.reduce((m, i) => Math.max(m, i.z), 0);
          let zLow = existing.reduce((m, i) => Math.min(m, i.z), 0);
          const placed: { x: number; y: number; w: number; h: number; type: string }[] = existing.filter((i) => i.type !== "connector").map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h, type: i.type }));
          const frames = new Map(existing.filter((i) => i.type === "frame").map((i) => [i.id, i]));
          const refs = new Map<string, string>();
          const free = (x: number, y: number, w: number, h: number) => !placed.some((p) => p.type !== "frame" && x < p.x + p.w + 20 && x + w + 20 > p.x && y < p.y + p.h + 20 && y + h + 20 > p.y);
          const right = () => (placed.length ? Math.max(...placed.map((p) => p.x + p.w)) + 160 : 0);
          const top = () => (placed.length ? Math.min(...placed.map((p) => p.y)) : 0);
          const resolve = (v: unknown) => (typeof v === "string" ? refs.get(v) ?? v : undefined);
          const rows: Record<string, unknown>[] = [];
          const out: Record<string, string> = {};

          for (const [n, it] of list.entries()) {
            const type = oneOf(it.type, `items[${n}].type`, ["sticky", "text", "shape", "frame", "card", "link", "emoji", "connector"] as const);
            const id = crypto.randomUUID();
            const text = typeof it.text === "string" ? it.text.slice(0, 5000) : "";
            if (type === "connector") {
              const from = resolve(it.from);
              const to = resolve(it.to);
              if (!from || !to) throw new UserError(`items[${n}]: a connector needs from and to`);
              rows.push({ id, board_id: b.id, type, x: 0, y: 0, w: 0, h: 0, z: ++z, data: { start: { id: from, side: "auto" }, end: { id: to, side: "auto" }, kind: "curved", color: "ink", width: 2, dash: "solid", startCap: "none", endCap: "arrow", ...(text ? { label: text } : {}) } });
              if (typeof it.ref === "string") refs.set(it.ref, id);
              out[typeof it.ref === "string" ? it.ref : `#${n}`] = id;
              continue;
            }
            const fs = optNum(it.font_size, "font_size") ?? (type === "text" ? 20 : 16);
            const size =
              type === "sticky" ? { w: 200, h: 200 }
              : type === "frame" ? { w: 1280, h: 720 }
              : type === "card" ? { w: 320, h: 140 }
              : type === "shape" ? { w: 160, h: 160 }
              : type === "emoji" ? { w: 72, h: 72 }
              : type === "link" ? embedSize(str(it.url, `items[${n}].url`, 2000))
              : textSize(text || "Text", fs);
            const w = Math.max(8, optNum(it.w, "w") ?? size.w);
            const h = Math.max(8, optNum(it.h, "h") ?? (type === "sticky" && it.w !== undefined ? w : size.h));
            const frameId = it.frame !== undefined ? resolve(it.frame) : undefined;
            const frame = frameId ? frames.get(frameId) : undefined;
            if (frameId && !frame) throw new UserError(`items[${n}].frame is not a frame on this board`);
            let x = optNum(it.x, "x");
            let y = optNum(it.y, "y");
            if (frame && x !== undefined && y !== undefined) {
              x += frame.x;
              y += frame.y;
            }
            if (x === undefined || y === undefined) {
              if (frame) {
                let spot: { x: number; y: number } | null = null;
                for (let yy = frame.y + 100; yy + h <= frame.y + frame.h - 20 && !spot; yy += 40) for (let xx = frame.x + 40; xx + w <= frame.x + frame.w - 20 && !spot; xx += 40) if (free(xx, yy, w, h)) spot = { x: xx, y: yy };
                ({ x, y } = spot ?? { x: frame.x + 40, y: frame.y + 100 });
              } else {
                x = right();
                y = top();
                while (!free(x, y, w, h)) y += 40;
              }
            }
            const c2 = it.color;
            const data: Record<string, unknown> =
              type === "sticky" ? { text, fill: fill(c2, "#f5cd47"), fontSize: "auto", align: "center", valign: "middle" }
              : type === "text" ? { text, fontSize: fs, color: c2 ? fill(c2, "ink") : "ink", align: "left", autoWidth: it.w === undefined, ...(it.bold ? { bold: true } : {}) }
              : type === "shape" ? { shape: typeof it.shape === "string" ? it.shape : "rect", fill: fill(c2, "surface"), stroke: "ink", strokeWidth: 2, dash: "solid", text, fontSize: fs, align: "center", valign: "middle", ...(it.bold ? { bold: true } : {}) }
              : type === "frame" ? { title: text || "Frame", fill: fill(c2, "surface") }
              : type === "card" ? { title: text, description: typeof it.description === "string" ? it.description : "", fill: fill(c2, "#579dff"), assignee: null, due: null }
              : type === "link" ? { url: str(it.url, `items[${n}].url`, 2000) }
              : { emoji: str(it.emoji ?? text, `items[${n}].emoji`, 16) };
            const row: Record<string, unknown> = { id, board_id: b.id, type: type === "link" ? "embed" : type, x, y, w, h, z: type === "frame" ? --zLow : ++z, frame_id: type === "frame" ? null : frame?.id ?? null, data };
            rows.push(row);
            placed.push({ x: x!, y: y!, w, h, type });
            if (type === "frame") frames.set(id, { id, type, x: x!, y: y!, w, h, z: row.z as number, frame_id: null, data });
            if (typeof it.ref === "string") refs.set(it.ref, id);
            out[typeof it.ref === "string" ? it.ref : `#${n}`] = id;
          }
          await ok(c.db.from("wb_item").insert(rows), "Add items");
          return { added: rows.length, ids: out, url: boardUrl(c, b) };
        },
        update: async () => {
          const b = await boardOf(c, uuid(a.board_id, "board_id"), "whiteboard");
          const list = Array.isArray(a.items) ? (a.items as Args[]) : [];
          if (!list.length) throw new UserError("items is empty");
          const all = new Map((await items(c, b.id)).map((i) => [i.id, i]));
          let n = 0;
          for (const it of list) {
            const cur = all.get(uuid(it.id, "items[].id"));
            if (!cur) throw new UserError(`No item ${it.id} on this board`);
            const patch: Record<string, unknown> = {};
            const data = { ...cur.data };
            for (const k of ["x", "y", "w", "h"] as const) if (it[k] !== undefined) patch[k] = num(it[k], k);
            if (it.text !== undefined) {
              const t = typeof it.text === "string" ? it.text.slice(0, 5000) : "";
              if (cur.type === "card" || cur.type === "frame" || cur.type === "doc") data.title = t;
              else if (cur.type === "connector") data.label = t;
              else data.text = t;
            }
            if (it.description !== undefined && cur.type === "card") data.description = String(it.description ?? "");
            if (it.color !== undefined) {
              if (cur.type === "text" || cur.type === "connector") data.color = fill(it.color, "ink");
              else data.fill = fill(it.color, "surface");
            }
            if (it.font_size !== undefined) data.fontSize = num(it.font_size, "font_size");
            if (bool(it.bold) !== undefined) data.bold = it.bold;
            if (it.frame !== undefined && cur.type !== "frame") patch.frame_id = it.frame === "none" || it.frame === null ? null : uuid(it.frame, "frame");
            patch.data = data;
            // A frame carries what's in it.
            if (cur.type === "frame" && (patch.x !== undefined || patch.y !== undefined)) {
              const dx = (patch.x as number ?? cur.x) - cur.x;
              const dy = (patch.y as number ?? cur.y) - cur.y;
              for (const k of all.values()) if (k.frame_id === cur.id) await ok(c.db.from("wb_item").update({ x: k.x + dx, y: k.y + dy }).eq("id", k.id), "Move frame contents");
            }
            await changed(c.db.from("wb_item").update(patch).eq("id", cur.id).select("id"), "Update item");
            n++;
          }
          return { updated: n };
        },
        delete: async () => {
          const b = await boardOf(c, uuid(a.board_id, "board_id"), "whiteboard");
          const ids = (Array.isArray(a.ids) ? a.ids : []).map((x) => uuid(x, "ids[]"));
          if (!ids.length) throw new UserError("ids is empty");
          const r = await c.db.from("wb_item").delete().eq("board_id", b.id).in("id", ids).select("id");
          if (r.error) throw new UserError(`Delete: ${r.error.message}`);
          return { deleted: r.data?.length ?? 0 };
        },
      }),
  },
  {
    name: "miro_comment",
    title: "Comment on Miro boards",
    description:
      "Miro comments as the user. add {board_id, text, item_id? | x?, y?} starts a thread (@username mentions notify people); reply {thread_id, text}; edit {comment_id, text} (own); resolve / reopen {thread_id}; delete {comment_id}.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "reply", "edit", "resolve", "reopen", "delete"] },
        board_id: { type: "string" }, item_id: { type: "string" }, thread_id: { type: "string" }, comment_id: { type: "string" },
        text: { type: "string" }, x: { type: "number" }, y: { type: "number" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { ...W, destructiveHint: true },
    run: (a, c) =>
      actions(a, {
        add: async () => {
          const b = await boardOf(c, uuid(a.board_id, "board_id"), "whiteboard");
          let at: { item_id: string | null; x: number; y: number };
          if (a.item_id !== undefined) {
            const it = must(await c.db.from("wb_item").select("id, w").eq("board_id", b.id).eq("id", uuid(a.item_id, "item_id")).maybeSingle(), "Item") as { id: string; w: number };
            at = { item_id: it.id, x: it.w, y: 0 };
          } else if (a.x !== undefined && a.y !== undefined) {
            at = { item_id: null, x: num(a.x, "x"), y: num(a.y, "y") };
          } else {
            const first = await c.db.from("wb_item").select("x, y").eq("board_id", b.id).order("y").limit(1).maybeSingle();
            const p = first.data as { x: number; y: number } | null;
            at = { item_id: null, x: p?.x ?? 0, y: (p?.y ?? 40) - 40 };
          }
          const r = must(await c.db.from("wb_comment").insert({ board_id: b.id, author_id: c.uid, body: str(a.text, "text", 10000), ...at }).select("id").single(), "Comment") as { id: string };
          return { thread_id: r.id, url: `${boardUrl(c, b)}?comment=${r.id}` };
        },
        reply: async () => {
          const t = must(await c.db.from("wb_comment").select("id, board_id, thread_id").eq("id", uuid(a.thread_id, "thread_id")).maybeSingle(), "Thread") as { id: string; board_id: string; thread_id: string | null };
          const r = must(await c.db.from("wb_comment").insert({ board_id: t.board_id, thread_id: t.thread_id ?? t.id, author_id: c.uid, body: str(a.text, "text", 10000) }).select("id").single(), "Reply") as { id: string };
          return { comment_id: r.id };
        },
        edit: async () => {
          const id = uuid(a.comment_id, "comment_id");
          await changed(c.db.from("wb_comment").update({ body: str(a.text, "text", 10000) }).eq("id", id).eq("author_id", c.uid).select("id"), "Edit comment");
          return { comment_id: id };
        },
        resolve: async () => {
          const id = uuid(a.thread_id, "thread_id");
          await changed(c.db.from("wb_comment").update({ resolved: true }).eq("id", id).select("id"), "Resolve");
          return { thread_id: id, resolved: true };
        },
        reopen: async () => {
          const id = uuid(a.thread_id, "thread_id");
          await changed(c.db.from("wb_comment").update({ resolved: false }).eq("id", id).select("id"), "Reopen");
          return { thread_id: id, resolved: false };
        },
        delete: async () => {
          const id = uuid(a.comment_id, "comment_id");
          await changed(c.db.from("wb_comment").delete().eq("id", id).select("id"), "Delete comment");
          return { deleted_comment: id };
        },
      }),
  },
];
