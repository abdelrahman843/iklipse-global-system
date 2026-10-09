// Trello side of the MCP: boards, lists, cards, checklists, labels, comments.
// Same writes as the app (src/lib/pm/*), as the signed-in person.

import {
  actions, bool, boardOf, cardUrl, boardUrl, changed, date, must, ok, oneOf, optStr, optUuid, person, rank, rankLast, str, uuid,
  UserError, type Ctx, type Tool,
} from "./lib.ts";

export const COLORS: Record<string, string> = {
  green: "#4bce97", yellow: "#f5cd47", orange: "#fea362", red: "#f87168", purple: "#9f8fef",
  blue: "#579dff", sky: "#6cc3e0", lime: "#94c748", pink: "#e774bb", grey: "#8590a2",
};
const color = (v: unknown, name = "color"): string | null => {
  if (v === null || v === "none") return null;
  if (typeof v === "string" && COLORS[v]) return COLORS[v]!;
  if (typeof v === "string" && Object.values(COLORS).includes(v.toLowerCase())) return v.toLowerCase();
  throw new UserError(`${name} must be one of: ${Object.keys(COLORS).join(", ")} (or none)`);
};
const ROLE: Record<string, string> = { admin: "admin", member: "normal", observer: "observer" };
const roleOf = (v: unknown) => ROLE[oneOf(v, "role", ["admin", "member", "observer"] as const)]!;

async function cardRow(c: Ctx, id: string) {
  return must(await c.db.from("card").select("id, board_id, list_id, title, position").eq("id", id).maybeSingle(), "Card") as {
    id: string; board_id: string; list_id: string; title: string; position: string;
  };
}
async function listRow(c: Ctx, id: string) {
  return must(await c.db.from("list").select("id, board_id, title, position").eq("id", id).maybeSingle(), "List") as {
    id: string; board_id: string; title: string; position: string;
  };
}
/** Positions around where a card should go in a list: top, bottom, or after a card. */
async function cardSlot(c: Ctx, listId: string, where: unknown, after: unknown, skip?: string): Promise<{ prev: string | null; next: string | null }> {
  let q = c.db.from("card").select("id, position").eq("list_id", listId).eq("is_archived", false).order("position");
  if (skip) q = q.neq("id", skip);
  const rows = (must(await q, "Cards") as { id: string; position: string }[]);
  if (after !== undefined && after !== null) {
    const i = rows.findIndex((r) => r.id === after);
    if (i < 0) throw new UserError("after_card_id is not a card in that list");
    return { prev: rows[i]!.position, next: rows[i + 1]?.position ?? null };
  }
  if (where === "top") return { prev: null, next: rows[0]?.position ?? null };
  return { prev: rows.at(-1)?.position ?? null, next: null };
}
async function labelByName(c: Ctx, boardId: string, v: unknown): Promise<string> {
  const q = str(v, "label", 100);
  if (/^[0-9a-f-]{36}$/i.test(q)) return q;
  const rows = must(await c.db.from("label").select("id, name, color").eq("board_id", boardId), "Labels") as { id: string; name: string | null; color: string }[];
  const hit = rows.find((l) => (l.name ?? "").toLowerCase() === q.toLowerCase()) ?? rows.find((l) => !l.name && (COLORS[q] === l.color || q.toLowerCase() === l.color));
  if (!hit) throw new UserError(`label: no label "${q}" on this board (see get_trello_board, or create one with trello_label)`);
  return hit.id;
}

// ------------------------------------------------------------------- read --
export const trelloRead: Tool[] = [
  {
    name: "get_trello_board",
    title: "Get a Trello board",
    description:
      "A Trello board: its settings, members, labels, custom fields, and every list with its cards (ids, title, due, done, labels, members). Use the ids with the other trello_* tools. include_archived also lists archived lists and cards.",
    inputSchema: {
      type: "object",
      properties: { board_id: { type: "string" }, include_archived: { type: "boolean" } },
      required: ["board_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, c) => {
      const b = await boardOf(c, uuid(a.board_id, "board_id"), "kanban");
      const arch = a.include_archived === true;
      const [board, lists, cards, labels, members, cardMembers, cardLabels, fields] = await Promise.all([
        c.db.from("board").select("description, visibility, comment_policy, member_policy, self_join, is_archived").eq("id", b.id).single(),
        arch ? c.db.from("list").select("id, title, is_archived, is_done, color").eq("board_id", b.id).order("position") : c.db.from("list").select("id, title, is_archived, is_done, color").eq("board_id", b.id).eq("is_archived", false).order("position"),
        (arch ? c.db.from("card").select("id, list_id, title, due_date, start_date, due_completed, is_archived, cover_color") : c.db.from("card").select("id, list_id, title, due_date, start_date, due_completed, is_archived, cover_color").eq("is_archived", false))
          .eq("board_id", b.id).eq("is_template", false).order("position").limit(2000),
        c.db.from("label").select("id, name, color").eq("board_id", b.id).order("position"),
        c.db.from("board_member").select("role, profile:user_id(id, display_name, username)").eq("board_id", b.id),
        c.db.from("card_member").select("card_id, profile:user_id(username)").eq("board_id", b.id),
        c.db.from("card_label").select("card_id, label_id").eq("board_id", b.id),
        c.db.from("custom_field_def").select("id, name, type, options").eq("board_id", b.id).order("position"),
      ]);
      const colorName = (hex: string | null) => (hex ? Object.entries(COLORS).find(([, v]) => v === hex)?.[0] ?? hex : undefined);
      const labelList = must(labels, "Labels") as { id: string; name: string | null; color: string }[];
      const labelName = new Map(labelList.map((l) => [l.id, l.name || colorName(l.color)!]));
      const memberOf = new Map<string, string[]>();
      for (const m of must(cardMembers, "Card members") as { card_id: string; profile: { username: string } | null }[]) {
        if (m.profile) memberOf.set(m.card_id, [...(memberOf.get(m.card_id) ?? []), `@${m.profile.username}`]);
      }
      const labelsOf = new Map<string, string[]>();
      for (const l of must(cardLabels, "Card labels") as { card_id: string; label_id: string }[]) labelsOf.set(l.card_id, [...(labelsOf.get(l.card_id) ?? []), labelName.get(l.label_id) ?? ""]);
      const allCards = must(cards, "Cards") as { id: string; list_id: string; title: string; due_date: string | null; start_date: string | null; due_completed: boolean; is_archived: boolean; cover_color: string | null }[];
      return {
        board: { id: b.id, title: b.title, url: boardUrl(c, b), ...(must(board, "Board") as object) },
        members: (must(members, "Members") as { role: string; profile: { id: string; display_name: string; username: string } | null }[]).map((m) => ({
          id: m.profile?.id, name: m.profile?.display_name, username: m.profile?.username, role: m.role === "normal" ? "member" : m.role,
        })),
        labels: labelList.map((l) => ({ id: l.id, name: l.name || undefined, color: colorName(l.color) })),
        custom_fields: must(fields, "Custom fields"),
        lists: (must(lists, "Lists") as { id: string; title: string; is_archived: boolean; is_done: boolean; color: string | null }[]).map((l) => ({
          id: l.id, title: l.title, archived: l.is_archived || undefined, done_list: l.is_done || undefined, color: colorName(l.color),
          cards: allCards.filter((x) => x.list_id === l.id).map((x) => ({
            id: x.id, title: x.title, start: x.start_date ?? undefined, due: x.due_date ?? undefined, done: x.due_completed || undefined,
            archived: x.is_archived || undefined, cover: colorName(x.cover_color), labels: labelsOf.get(x.id), members: memberOf.get(x.id),
          })),
        })),
      };
    },
  },
  {
    name: "get_card",
    title: "Get a Trello card",
    description: "Everything on a Trello card with ids: description, dates, members, labels, checklists and items, attachments, custom field values, and comments (with replies).",
    inputSchema: { type: "object", properties: { card_id: { type: "string" } }, required: ["card_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, c) => {
      const id = uuid(a.card_id, "card_id");
      const card = must(
        await c.db.from("card").select("id, board_id, list_id, title, description, start_date, due_date, due_completed, is_archived, cover_color, created_at, list:list_id(title), board:board_id(title)").eq("id", id).maybeSingle(),
        "Card",
      ) as Record<string, unknown> & { board_id: string; list: { title: string } | null; board: { title: string } | null };
      const [members, labels, checklists, items, attachments, values, comments, watching] = await Promise.all([
        c.db.from("card_member").select("profile:user_id(id, display_name, username)").eq("card_id", id),
        c.db.from("card_label").select("label:label_id(id, name, color)").eq("card_id", id),
        c.db.from("checklist").select("id, name").eq("card_id", id).order("position"),
        c.db.from("checklist_item").select("id, checklist_id, text, completed, due_date, assignee:assignee_id(username)").eq("card_id", id).order("position"),
        c.db.from("attachment").select("id, name, external_url, storage_path, created_at").eq("card_id", id).order("created_at"),
        c.db.from("custom_field_value").select("value, field:field_id(id, name, type)").eq("card_id", id),
        c.db.from("comment").select("id, parent_id, body, created_at, edited_at, author:author_id(display_name, username)").eq("card_id", id).order("created_at").limit(200),
        c.db.from("subscription").select("user_id").eq("user_id", c.uid).eq("entity_type", "card").eq("entity_id", id).maybeSingle(),
      ]);
      const its = must(items, "Checklist items") as { id: string; checklist_id: string; text: string; completed: boolean; due_date: string | null; assignee: { username: string } | null }[];
      const coms = must(comments, "Comments") as { id: string; parent_id: string | null; body: string; created_at: string; edited_at: string | null; author: { display_name: string; username: string } | null }[];
      const fmt = (m: (typeof coms)[number]) => ({ id: m.id, by: m.author ? `${m.author.display_name} (@${m.author.username})` : undefined, at: m.created_at, edited: !!m.edited_at || undefined, text: m.body });
      return {
        id: card.id, title: card.title, url: cardUrl(c, card.board_id, id), board_id: card.board_id, board: card.board?.title,
        list_id: card.list_id, list: card.list?.title, description: card.description || undefined,
        start: card.start_date ?? undefined, due: card.due_date ?? undefined, done: card.due_completed, archived: card.is_archived || undefined,
        watching: !!watching.data,
        members: (must(members, "Members") as { profile: { id: string; display_name: string; username: string } | null }[]).map((m) => m.profile),
        labels: (must(labels, "Labels") as { label: { id: string; name: string | null; color: string } | null }[]).map((l) => l.label),
        checklists: (must(checklists, "Checklists") as { id: string; name: string }[]).map((cl) => ({
          id: cl.id, name: cl.name,
          items: its.filter((i) => i.checklist_id === cl.id).map((i) => ({ id: i.id, text: i.text, done: i.completed, due: i.due_date ?? undefined, assignee: i.assignee ? `@${i.assignee.username}` : undefined })),
        })),
        attachments: (must(attachments, "Attachments") as { id: string; name: string; external_url: string | null; storage_path: string | null }[]).map((x) => ({ id: x.id, name: x.name, link: x.external_url ?? undefined, file: !!x.storage_path || undefined })),
        custom_fields: (must(values, "Custom fields") as { value: unknown; field: { id: string; name: string; type: string } | null }[]).map((v) => ({ ...v.field, value: v.value })),
        comments: coms.filter((m) => !m.parent_id).map((m) => ({ ...fmt(m), replies: coms.filter((r) => r.parent_id === m.id).map(fmt) })),
      };
    },
  },
  {
    name: "search_cards",
    title: "Search Trello cards",
    description: "Full-text search over Trello card titles and descriptions on every board the user can see.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, c) => {
      const limit = Math.min(50, Math.max(1, Number(a.limit) || 20));
      const rows = must(await c.db.rpc("search_cards", { p_query: str(a.query, "query", 200), p_limit: limit }), "Search") as {
        card_id: string; board_id: string; board_title: string; list_title: string; title: string; due_date: string | null;
      }[];
      return rows.map((r) => ({ card_id: r.card_id, title: r.title, board: r.board_title, list: r.list_title, due: r.due_date ?? undefined, url: cardUrl(c, r.board_id, r.card_id) }));
    },
  },
  {
    name: "my_work",
    title: "My Trello cards",
    description: "Trello cards the user is a member of that aren't done: overdue first, then by due date.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_a, c) => {
      const mine = must(await c.db.from("card_member").select("card_id").eq("user_id", c.uid).limit(1000), "Cards") as { card_id: string }[];
      if (!mine.length) return [];
      const cards = must(
        await c.db.from("card").select("id, board_id, title, due_date, list:list_id(title, is_done), board:board_id(title)")
          .in("id", mine.map((m) => m.card_id)).eq("is_archived", false).eq("due_completed", false),
        "Cards",
      ) as { id: string; board_id: string; title: string; due_date: string | null; list: { title: string; is_done: boolean } | null; board: { title: string } | null }[];
      const now = Date.now();
      return cards
        .filter((x) => !x.list?.is_done)
        .sort((x, y) => (x.due_date ? Date.parse(x.due_date) : Infinity) - (y.due_date ? Date.parse(y.due_date) : Infinity))
        .map((x) => ({ card_id: x.id, title: x.title, board: x.board?.title, list: x.list?.title, due: x.due_date ?? undefined, overdue: x.due_date ? Date.parse(x.due_date) < now : undefined, url: cardUrl(c, x.board_id, x.id) }));
    },
  },
];

// ------------------------------------------------------------------ write --
const W = { readOnlyHint: false, openWorldHint: false } as const;

export const trelloWrite: Tool[] = [
  {
    name: "trello_board",
    title: "Manage a Trello board",
    description:
      "Trello board actions. create {title, description?, visibility?: workspace|private}; update {board_id, title?, description?, visibility?, comment_policy?: disabled|members|observers|workspace, member_policy?: admins|members, self_join?}; archive / restore {board_id}; delete {board_id} (permanent, ask the user first); add_member / set_member_role {board_id, user, role: admin|member|observer}; remove_member {board_id, user}; join {board_id} (a workspace board you can see).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "archive", "restore", "delete", "add_member", "set_member_role", "remove_member", "join"] },
        board_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        visibility: { type: "string", enum: ["workspace", "private"] },
        comment_policy: { type: "string", enum: ["disabled", "members", "observers", "workspace"] },
        member_policy: { type: "string", enum: ["admins", "members"] },
        self_join: { type: "boolean" },
        user: { type: "string", description: "Person: @username, name or id (see list_people)." },
        role: { type: "string", enum: ["admin", "member", "observer"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { ...W, destructiveHint: true },
    run: (a, c) =>
      actions(a, {
        create: async () => {
          const id = must(await c.db.rpc("create_board", {
            p_title: str(a.title, "title", 200), p_description: optStr(a.description, 5000) ?? null, p_background: null,
            p_visibility: a.visibility === "private" ? "private" : "workspace", p_kind: "kanban",
          }), "Create board") as string;
          return { board_id: id, url: boardUrl(c, { id, kind: "kanban" }), note: "Starts empty: add lists with trello_list create." };
        },
        update: async () => {
          const b = await boardOf(c, uuid(a.board_id, "board_id"), "kanban");
          const patch: Record<string, unknown> = {};
          if (a.title !== undefined) patch.title = str(a.title, "title", 200);
          if (a.description !== undefined) patch.description = typeof a.description === "string" ? a.description.slice(0, 5000) : null;
          if (a.visibility !== undefined) patch.visibility = oneOf(a.visibility, "visibility", ["workspace", "private"] as const);
          if (a.comment_policy !== undefined) patch.comment_policy = oneOf(a.comment_policy, "comment_policy", ["disabled", "members", "observers", "workspace"] as const);
          if (a.member_policy !== undefined) patch.member_policy = oneOf(a.member_policy, "member_policy", ["admins", "members"] as const);
          if (bool(a.self_join) !== undefined) patch.self_join = a.self_join;
          if (!Object.keys(patch).length) throw new UserError("Nothing to change");
          await changed(c.db.from("board").update(patch).eq("id", b.id).select("id"), "Update board");
          return { board_id: b.id, updated: Object.keys(patch) };
        },
        archive: async () => {
          const b = await boardOf(c, uuid(a.board_id, "board_id"), "kanban");
          await changed(c.db.from("board").update({ is_archived: true }).eq("id", b.id).select("id"), "Archive board");
          return { board_id: b.id, archived: true };
        },
        restore: async () => {
          const id = uuid(a.board_id, "board_id");
          await changed(c.db.from("board").update({ is_archived: false }).eq("id", id).select("id"), "Restore board");
          return { board_id: id, archived: false };
        },
        delete: async () => {
          const b = await boardOf(c, uuid(a.board_id, "board_id"), "kanban");
          await changed(c.db.from("board").delete().eq("id", b.id).select("id"), "Delete board");
          return { deleted: b.title };
        },
        add_member: async () => {
          const b = await boardOf(c, uuid(a.board_id, "board_id"), "kanban");
          const p = await person(c, a.user);
          await ok(c.db.from("board_member").insert({ board_id: b.id, user_id: p.id, role: roleOf(a.role ?? "member") }), "Add member");
          return { board: b.title, added: p.display_name, role: a.role ?? "member" };
        },
        set_member_role: async () => {
          const b = await boardOf(c, uuid(a.board_id, "board_id"), "kanban");
          const p = await person(c, a.user);
          await changed(c.db.from("board_member").update({ role: roleOf(a.role) }).eq("board_id", b.id).eq("user_id", p.id).select("user_id"), "Set role");
          return { board: b.title, user: p.display_name, role: a.role };
        },
        remove_member: async () => {
          const b = await boardOf(c, uuid(a.board_id, "board_id"), "kanban");
          const p = await person(c, a.user);
          await changed(c.db.from("board_member").delete().eq("board_id", b.id).eq("user_id", p.id).select("user_id"), "Remove member");
          return { board: b.title, removed: p.display_name };
        },
        join: async () => {
          const b = await boardOf(c, uuid(a.board_id, "board_id"), "kanban");
          await ok(c.db.from("board_member").insert({ board_id: b.id, user_id: c.uid, role: "normal" }), "Join board");
          return { joined: b.title };
        },
      }),
  },
  {
    name: "trello_list",
    title: "Manage Trello lists",
    description:
      "Trello list actions. create {board_id, title, after_list_id?} (default at the end); rename {list_id, title}; move {list_id, after_list_id? | to: first|last}; set_color {list_id, color: green|yellow|orange|red|purple|blue|sky|lime|pink|grey|none}; set_done {list_id, done} (its cards count as finished); copy {list_id, title?}; archive / restore {list_id}; delete {list_id} (permanent with all its cards, ask first).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "rename", "move", "set_color", "set_done", "copy", "archive", "restore", "delete"] },
        board_id: { type: "string" }, list_id: { type: "string" }, title: { type: "string" },
        after_list_id: { type: "string" }, to: { type: "string", enum: ["first", "last"] },
        color: { type: "string" }, done: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { ...W, destructiveHint: true },
    run: (a, c) => {
      const slot = async (boardId: string, after: unknown, to: unknown, skip?: string) => {
        let q = c.db.from("list").select("id, position").eq("board_id", boardId).eq("is_archived", false).order("position");
        if (skip) q = q.neq("id", skip);
        const rows = must(await q, "Lists") as { id: string; position: string }[];
        if (after) {
          const i = rows.findIndex((r) => r.id === after);
          if (i < 0) throw new UserError("after_list_id is not a list on this board");
          return { prev: rows[i]!.position, next: rows[i + 1]?.position ?? null };
        }
        return to === "first" ? { prev: null, next: rows[0]?.position ?? null } : { prev: rows.at(-1)?.position ?? null, next: null };
      };
      return actions(a, {
        create: async () => {
          const b = await boardOf(c, uuid(a.board_id, "board_id"), "kanban");
          const s = await slot(b.id, optUuid(a.after_list_id, "after_list_id"), a.to);
          const r = must(await c.db.from("list").insert({ board_id: b.id, title: str(a.title, "title", 200), position: await rank(c, s.prev, s.next) }).select("id").single(), "Create list") as { id: string };
          return { list_id: r.id };
        },
        rename: async () => {
          const id = uuid(a.list_id, "list_id");
          await changed(c.db.from("list").update({ title: str(a.title, "title", 200) }).eq("id", id).select("id"), "Rename list");
          return { list_id: id };
        },
        move: async () => {
          const l = await listRow(c, uuid(a.list_id, "list_id"));
          const s = await slot(l.board_id, optUuid(a.after_list_id, "after_list_id"), a.to ?? "last", l.id);
          await ok(c.db.rpc("reorder_list", { p_list_id: l.id, p_prev_position: s.prev, p_next_position: s.next }), "Move list");
          return { list_id: l.id, moved: true };
        },
        set_color: async () => {
          const id = uuid(a.list_id, "list_id");
          await changed(c.db.from("list").update({ color: color(a.color) }).eq("id", id).select("id"), "List color");
          return { list_id: id };
        },
        set_done: async () => {
          const id = uuid(a.list_id, "list_id");
          await changed(c.db.from("list").update({ is_done: a.done !== false }).eq("id", id).select("id"), "Done list");
          return { list_id: id, done_list: a.done !== false };
        },
        copy: async () => {
          const l = await listRow(c, uuid(a.list_id, "list_id"));
          const s = await slot(l.board_id, l.id, undefined);
          const nl = must(await c.db.from("list").insert({ board_id: l.board_id, title: optStr(a.title, 200) ?? `${l.title} (copy)`, position: await rank(c, s.prev, s.next) }).select("id").single(), "Copy list") as { id: string };
          const cards = must(await c.db.from("card").select("id").eq("list_id", l.id).eq("is_archived", false).order("position"), "Cards") as { id: string }[];
          let prev: string | null = null;
          for (const x of cards) {
            const nid = must(await c.db.rpc("clone_card", { p_source_card: x.id, p_target_list: nl.id, p_after_position: null }), "Copy card") as string;
            prev = await rank(c, prev, null);
            await ok(c.db.from("card").update({ position: prev }).eq("id", nid), "Order copy");
          }
          return { list_id: nl.id, cards_copied: cards.length };
        },
        archive: async () => {
          const id = uuid(a.list_id, "list_id");
          await changed(c.db.from("list").update({ is_archived: true }).eq("id", id).select("id"), "Archive list");
          return { list_id: id, archived: true };
        },
        restore: async () => {
          const id = uuid(a.list_id, "list_id");
          await changed(c.db.from("list").update({ is_archived: false }).eq("id", id).select("id"), "Restore list");
          return { list_id: id, archived: false };
        },
        delete: async () => {
          const id = uuid(a.list_id, "list_id");
          await changed(c.db.from("list").delete().eq("id", id).select("id"), "Delete list");
          return { deleted_list: id };
        },
      });
    },
  },
  {
    name: "trello_card",
    title: "Manage Trello cards",
    description:
      "Trello card actions. create {list_id, title, description?, start?, due?, position?: top|bottom} ; update {card_id, title?, description?, start?, due? (ISO or null), done?, cover?: color|none}; move {card_id, list_id?, position?: top|bottom, after_card_id?} (any list on the same board); copy {card_id, list_id?, title?}; archive / restore {card_id}; delete {card_id} (permanent, ask first); add_member / remove_member {card_id, user}; add_label / remove_label {card_id, label: name, color or id}; watch / unwatch {card_id}; add_link {card_id, url, name?} (link attachment); remove_attachment {attachment_id}; set_field {card_id, field: name or id, value} (null clears).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "move", "copy", "archive", "restore", "delete", "add_member", "remove_member", "add_label", "remove_label", "watch", "unwatch", "add_link", "remove_attachment", "set_field"],
        },
        card_id: { type: "string" }, list_id: { type: "string" }, title: { type: "string" }, description: { type: "string" },
        start: { type: ["string", "null"] }, due: { type: ["string", "null"] }, done: { type: "boolean" }, cover: { type: "string" },
        position: { type: "string", enum: ["top", "bottom"] }, after_card_id: { type: "string" },
        user: { type: "string" }, label: { type: "string" }, url: { type: "string" }, name: { type: "string" },
        attachment_id: { type: "string" }, field: { type: "string" }, value: {},
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { ...W, destructiveHint: true },
    run: (a, c) =>
      actions(a, {
        create: async () => {
          const l = await listRow(c, uuid(a.list_id, "list_id"));
          await boardOf(c, l.board_id, "kanban");
          const s = await cardSlot(c, l.id, a.position, undefined);
          const card = must(await c.db.from("card").insert({
            board_id: l.board_id, list_id: l.id, title: str(a.title, "title", 500), description: optStr(a.description, 20000) ?? null,
            start_date: date(a.start, "start") ?? null, due_date: date(a.due, "due") ?? null, position: await rank(c, s.prev, s.next), created_by: c.uid,
          }).select("id").single(), "Create card") as { id: string };
          return { card_id: card.id, list: l.title, url: cardUrl(c, l.board_id, card.id) };
        },
        update: async () => {
          const x = await cardRow(c, uuid(a.card_id, "card_id"));
          const patch: Record<string, unknown> = {};
          if (a.title !== undefined) patch.title = str(a.title, "title", 500);
          if (a.description !== undefined) patch.description = typeof a.description === "string" ? a.description.slice(0, 20000) : null;
          const st = date(a.start, "start");
          if (st !== undefined) patch.start_date = st;
          const du = date(a.due, "due");
          if (du !== undefined) patch.due_date = du;
          if (bool(a.done) !== undefined) patch.due_completed = a.done;
          if (a.cover !== undefined) patch.cover_color = color(a.cover, "cover");
          if (!Object.keys(patch).length) throw new UserError("Nothing to change");
          await changed(c.db.from("card").update(patch).eq("id", x.id).select("id"), "Update card");
          return { card_id: x.id, updated: Object.keys(patch), url: cardUrl(c, x.board_id, x.id) };
        },
        move: async () => {
          const x = await cardRow(c, uuid(a.card_id, "card_id"));
          const to = a.list_id ? await listRow(c, uuid(a.list_id, "list_id")) : await listRow(c, x.list_id);
          if (to.board_id !== x.board_id) throw new UserError("list_id must be a list on the same board");
          const s = await cardSlot(c, to.id, a.position, optUuid(a.after_card_id, "after_card_id"), x.id);
          await ok(c.db.rpc("move_card", { p_card_id: x.id, p_list_id: to.id, p_prev_position: s.prev, p_next_position: s.next }), "Move card");
          return { card_id: x.id, list: to.title };
        },
        copy: async () => {
          const x = await cardRow(c, uuid(a.card_id, "card_id"));
          const to = a.list_id ? await listRow(c, uuid(a.list_id, "list_id")) : await listRow(c, x.list_id);
          const nid = must(await c.db.rpc("clone_card", { p_source_card: x.id, p_target_list: to.id, p_after_position: to.id === x.list_id ? x.position : null }), "Copy card") as string;
          if (optStr(a.title, 500)) await ok(c.db.from("card").update({ title: optStr(a.title, 500) }).eq("id", nid), "Rename copy");
          return { card_id: nid, list: to.title, url: cardUrl(c, to.board_id, nid) };
        },
        archive: async () => {
          const id = uuid(a.card_id, "card_id");
          await ok(c.db.rpc("set_card_archived", { p_card: id, p_archived: true }), "Archive card");
          return { card_id: id, archived: true };
        },
        restore: async () => {
          const id = uuid(a.card_id, "card_id");
          await ok(c.db.rpc("set_card_archived", { p_card: id, p_archived: false }), "Restore card");
          return { card_id: id, archived: false };
        },
        delete: async () => {
          const x = await cardRow(c, uuid(a.card_id, "card_id"));
          await changed(c.db.from("card").delete().eq("id", x.id).select("id"), "Delete card");
          return { deleted: x.title };
        },
        add_member: async () => {
          const x = await cardRow(c, uuid(a.card_id, "card_id"));
          const p = await person(c, a.user);
          await ok(c.db.from("card_member").insert({ card_id: x.id, user_id: p.id }), "Add member");
          return { card_id: x.id, added: p.display_name };
        },
        remove_member: async () => {
          const x = await cardRow(c, uuid(a.card_id, "card_id"));
          const p = await person(c, a.user);
          await changed(c.db.from("card_member").delete().eq("card_id", x.id).eq("user_id", p.id).select("card_id"), "Remove member");
          return { card_id: x.id, removed: p.display_name };
        },
        add_label: async () => {
          const x = await cardRow(c, uuid(a.card_id, "card_id"));
          await ok(c.db.from("card_label").insert({ card_id: x.id, label_id: await labelByName(c, x.board_id, a.label) }), "Add label");
          return { card_id: x.id, label_added: a.label };
        },
        remove_label: async () => {
          const x = await cardRow(c, uuid(a.card_id, "card_id"));
          await changed(c.db.from("card_label").delete().eq("card_id", x.id).eq("label_id", await labelByName(c, x.board_id, a.label)).select("card_id"), "Remove label");
          return { card_id: x.id, label_removed: a.label };
        },
        watch: async () => {
          const id = uuid(a.card_id, "card_id");
          await ok(c.db.rpc("set_subscription", { p_entity_type: "card", p_entity_id: id, p_watch: true }), "Watch");
          return { card_id: id, watching: true };
        },
        unwatch: async () => {
          const id = uuid(a.card_id, "card_id");
          await ok(c.db.rpc("set_subscription", { p_entity_type: "card", p_entity_id: id, p_watch: false }), "Unwatch");
          return { card_id: id, watching: false };
        },
        add_link: async () => {
          const x = await cardRow(c, uuid(a.card_id, "card_id"));
          let href = str(a.url, "url", 2000);
          if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
          let u: URL;
          try {
            u = new URL(href);
          } catch {
            throw new UserError("url is not a valid link");
          }
          const r = must(await c.db.from("attachment").insert({
            card_id: x.id, name: optStr(a.name, 200) ?? u.host.replace(/^www\./, "") + u.pathname.replace(/\/$/, ""), external_url: href, uploaded_by: c.uid,
          }).select("id").single(), "Add link") as { id: string };
          return { attachment_id: r.id };
        },
        remove_attachment: async () => {
          const id = uuid(a.attachment_id, "attachment_id");
          await changed(c.db.from("attachment").delete().eq("id", id).select("id"), "Remove attachment");
          return { removed_attachment: id };
        },
        set_field: async () => {
          const x = await cardRow(c, uuid(a.card_id, "card_id"));
          const f = str(a.field, "field", 100);
          const defs = must(await c.db.from("custom_field_def").select("id, name, type, options").eq("board_id", x.board_id), "Custom fields") as { id: string; name: string; type: string }[];
          const def = defs.find((d) => d.id === f || d.name.toLowerCase() === f.toLowerCase());
          if (!def) throw new UserError(`field: no custom field "${f}" on this board`);
          if (a.value === null || a.value === undefined || a.value === "") {
            await ok(c.db.from("custom_field_value").delete().eq("card_id", x.id).eq("field_id", def.id), "Clear field");
            return { card_id: x.id, field: def.name, value: null };
          }
          await ok(c.db.from("custom_field_value").upsert({ card_id: x.id, field_id: def.id, value: a.value }), "Set field");
          return { card_id: x.id, field: def.name, value: a.value };
        },
      }),
  },
  {
    name: "trello_checklist",
    title: "Manage card checklists",
    description:
      "Checklist actions on a Trello card. create {card_id, name, items?: string[]}; rename {checklist_id, name}; delete {checklist_id}; add_item {checklist_id, text, due?, assignee?}; update_item {item_id, text?, done?, due? (ISO or null), assignee? (person or none)}; delete_item {item_id}.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "rename", "delete", "add_item", "update_item", "delete_item"] },
        card_id: { type: "string" }, checklist_id: { type: "string" }, item_id: { type: "string" },
        name: { type: "string" }, text: { type: "string" }, items: { type: "array", items: { type: "string" }, maxItems: 100 },
        done: { type: "boolean" }, due: { type: ["string", "null"] }, assignee: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { ...W, destructiveHint: true },
    run: (a, c) =>
      actions(a, {
        create: async () => {
          const x = await cardRow(c, uuid(a.card_id, "card_id"));
          const cl = must(await c.db.from("checklist").insert({ card_id: x.id, name: str(a.name, "name", 200), position: await rankLast(c, "checklist", "card_id", x.id) }).select("id").single(), "Create checklist") as { id: string };
          let prev: string | null = null;
          for (const t of (Array.isArray(a.items) ? a.items : []).filter((t): t is string => typeof t === "string" && !!t.trim())) {
            prev = await rank(c, prev, null);
            await ok(c.db.from("checklist_item").insert({ checklist_id: cl.id, text: t.trim().slice(0, 1000), position: prev }), "Add item");
          }
          return { checklist_id: cl.id };
        },
        rename: async () => {
          const id = uuid(a.checklist_id, "checklist_id");
          await changed(c.db.from("checklist").update({ name: str(a.name, "name", 200) }).eq("id", id).select("id"), "Rename checklist");
          return { checklist_id: id };
        },
        delete: async () => {
          const id = uuid(a.checklist_id, "checklist_id");
          await changed(c.db.from("checklist").delete().eq("id", id).select("id"), "Delete checklist");
          return { deleted_checklist: id };
        },
        add_item: async () => {
          const id = uuid(a.checklist_id, "checklist_id");
          const row: Record<string, unknown> = { checklist_id: id, text: str(a.text, "text", 1000), position: await rankLast(c, "checklist_item", "checklist_id", id) };
          const du = date(a.due, "due");
          if (du) row.due_date = du;
          if (a.assignee && a.assignee !== "none") row.assignee_id = (await person(c, a.assignee, "assignee")).id;
          const r = must(await c.db.from("checklist_item").insert(row).select("id").single(), "Add item") as { id: string };
          return { item_id: r.id };
        },
        update_item: async () => {
          const id = uuid(a.item_id, "item_id");
          const patch: Record<string, unknown> = {};
          if (a.text !== undefined) patch.text = str(a.text, "text", 1000);
          if (bool(a.done) !== undefined) patch.completed = a.done;
          const du = date(a.due, "due");
          if (du !== undefined) patch.due_date = du;
          if (a.assignee !== undefined) patch.assignee_id = a.assignee === "none" || a.assignee === null ? null : (await person(c, a.assignee, "assignee")).id;
          if (!Object.keys(patch).length) throw new UserError("Nothing to change");
          await changed(c.db.from("checklist_item").update(patch).eq("id", id).select("id"), "Update item");
          return { item_id: id, updated: Object.keys(patch) };
        },
        delete_item: async () => {
          const id = uuid(a.item_id, "item_id");
          await changed(c.db.from("checklist_item").delete().eq("id", id).select("id"), "Delete item");
          return { deleted_item: id };
        },
      }),
  },
  {
    name: "trello_label",
    title: "Manage board labels",
    description: "A Trello board's labels. create {board_id, name?, color}; update {label_id, name?, color?}; delete {label_id} (removes it from every card).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "delete"] },
        board_id: { type: "string" }, label_id: { type: "string" }, name: { type: "string" },
        color: { type: "string", enum: Object.keys(COLORS) },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { ...W, destructiveHint: true },
    run: (a, c) =>
      actions(a, {
        create: async () => {
          const b = await boardOf(c, uuid(a.board_id, "board_id"), "kanban");
          const r = must(await c.db.from("label").insert({ board_id: b.id, name: optStr(a.name, 100) ?? "", color: color(a.color ?? "green"), position: await rankLast(c, "label", "board_id", b.id) }).select("id").single(), "Create label") as { id: string };
          return { label_id: r.id };
        },
        update: async () => {
          const id = uuid(a.label_id, "label_id");
          const patch: Record<string, unknown> = {};
          if (a.name !== undefined) patch.name = typeof a.name === "string" ? a.name.trim().slice(0, 100) : "";
          if (a.color !== undefined) patch.color = color(a.color);
          await changed(c.db.from("label").update(patch).eq("id", id).select("id"), "Update label");
          return { label_id: id };
        },
        delete: async () => {
          const id = uuid(a.label_id, "label_id");
          await changed(c.db.from("label").delete().eq("id", id).select("id"), "Delete label");
          return { deleted_label: id };
        },
      }),
  },
  {
    name: "trello_comment",
    title: "Comment on Trello cards",
    description:
      "Card comments as the user. add {card_id, text} (@username mentions notify people); reply {comment_id, text}; edit {comment_id, text} (own comments); delete {comment_id} (own, or as board admin; deleting a comment removes its replies); react {comment_id, emoji, on?: true|false}.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "reply", "edit", "delete", "react"] },
        card_id: { type: "string" }, comment_id: { type: "string" }, text: { type: "string" }, emoji: { type: "string" }, on: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { ...W, destructiveHint: true },
    run: (a, c) =>
      actions(a, {
        add: async () => {
          const x = await cardRow(c, uuid(a.card_id, "card_id"));
          const r = must(await c.db.from("comment").insert({ card_id: x.id, author_id: c.uid, body: str(a.text, "text", 10000) }).select("id").single(), "Comment") as { id: string };
          return { comment_id: r.id, url: cardUrl(c, x.board_id, x.id) };
        },
        reply: async () => {
          const root = must(await c.db.from("comment").select("id, card_id, parent_id").eq("id", uuid(a.comment_id, "comment_id")).maybeSingle(), "Comment") as { id: string; card_id: string; parent_id: string | null };
          const r = must(await c.db.from("comment").insert({ card_id: root.card_id, author_id: c.uid, body: str(a.text, "text", 10000), parent_id: root.parent_id ?? root.id }).select("id").single(), "Reply") as { id: string };
          return { comment_id: r.id };
        },
        edit: async () => {
          const id = uuid(a.comment_id, "comment_id");
          await changed(c.db.from("comment").update({ body: str(a.text, "text", 10000), edited_at: new Date().toISOString() }).eq("id", id).eq("author_id", c.uid).select("id"), "Edit comment");
          return { comment_id: id };
        },
        delete: async () => {
          const id = uuid(a.comment_id, "comment_id");
          await changed(c.db.from("comment").delete().eq("id", id).select("id"), "Delete comment");
          return { deleted_comment: id };
        },
        react: async () => {
          const id = uuid(a.comment_id, "comment_id");
          const emoji = str(a.emoji, "emoji", 16);
          if (a.on === false) await ok(c.db.from("comment_reaction").delete().eq("comment_id", id).eq("user_id", c.uid).eq("emoji", emoji), "React");
          else {
            const r = await c.db.from("comment_reaction").insert({ comment_id: id, user_id: c.uid, emoji });
            if (r.error && r.error.code !== "23505") throw new UserError(`React: ${r.error.message}`);
          }
          return { comment_id: id, emoji, on: a.on !== false };
        },
      }),
  },
];

