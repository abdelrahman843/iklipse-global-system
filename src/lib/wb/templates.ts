import { DEEP_COLORS, LIGHT_COLORS, type Cap, type ConnectorData, type ConnectorEnd, type ConnectorKind, type ShapeKind, type Side, type WbItem } from "./types";
import { makeCard, makeConnector, makeEmbed, makeEmoji, makeFrame, makeShape, makeSticky, makeText, makeTextBox } from "./factory";
import { maxZ } from "./store";
import { measureTextHeight, measureTextWidth } from "./text";
import { geomBounds, unionRects } from "./geometry";

// -----------------------------------------------------------------------------
// Board templates (Miro classics). Each one lays itself out from (0, 0);
// instantiate() moves the result so it is centred on a point. Colours come from
// the system palette only.
// -----------------------------------------------------------------------------

const [YELLOW, ORANGE, RED, PINK, PURPLE, BLUE, SKY, GREEN, LIME, GREY] = LIGHT_COLORS;
const [, D_ORANGE, D_RED, D_PINK, D_PURPLE, D_BLUE, D_SKY, D_GREEN, , SLATE] = DEEP_COLORS;

export interface WbTemplate {
  id: string;
  name: string;
  description: string;
  /** Items laid out from (0, 0), not yet placed. */
  build: () => WbItem[];
}

// --------------------------------------------------------------- builder --
type Extra = Record<string, unknown>;

/** Collects a template's items: stacking order follows the order they're added. */
class Builder {
  items: WbItem[] = [];
  private z = maxZ() + 1;
  private frame: WbItem | null = null;

  private add(it: WbItem): WbItem {
    if (it.type !== "frame") {
      it.z = this.z++;
      if (this.frame) it.frame_id = this.frame.id;
    }
    this.items.push(it);
    return it;
  }

  /** Frame plus a big heading and a one-line subtitle in its top-left corner. */
  frameWith(w: number, h: number, title: string, subtitle?: string, fill = "surface") {
    const f = makeFrame(0, 0, w, h, title, fill);
    this.items.push(f);
    this.frame = f;
    this.text(60, 48, title, 40, { bold: true });
    if (subtitle) this.text(60, 106, subtitle, 18);
    return f;
  }

  /** A frame at (x, y); what's added next goes on it. */
  frameAt(x: number, y: number, w: number, h: number, title: string, fill = "surface") {
    const f = makeFrame(x, y, w, h, title, fill);
    this.items.push(f);
    this.frame = f;
    return f;
  }

  /** A video box (an embed waiting for its link, unless one is given). */
  embed(x: number, y: number, w: number, h: number, url = "") {
    return this.add(makeEmbed(x + w / 2, y + h / 2, url, { w, h }));
  }

  sticky(cx: number, cy: number, fill: string, text = "", size = 200) {
    return this.add(makeSticky(cx, cy, fill, text, undefined, size));
  }

  shape(kind: ShapeKind, x: number, y: number, w: number, h: number, extra: Extra = {}) {
    return this.add(makeShape(kind, x, y, w, h, extra));
  }

  /** Flat coloured block (no outline) with optional title text. */
  block(x: number, y: number, w: number, h: number, fill: string, extra: Extra = {}) {
    return this.shape("round", x, y, w, h, { fill, strokeWidth: 0, ...extra });
  }

  /** Auto-width text (one line per paragraph). */
  text(x: number, y: number, text: string, size: number, extra: Extra = {}) {
    const it = makeText(x, y, text, size, extra);
    it.w = Math.max(40, measureTextWidth(text, size, "sans", !!extra.bold, !!extra.italic) + 4);
    it.h = Math.ceil(measureTextHeight(text, it.w, size, "sans", !!extra.bold, !!extra.italic));
    return this.add(it);
  }

  /** Auto-width text centred on a point. */
  textAt(cx: number, cy: number, text: string, size: number, extra: Extra = {}) {
    const it = this.text(0, 0, text, size, { align: "center", ...extra });
    it.x = cx - it.w / 2;
    it.y = cy - it.h / 2;
    return it;
  }

  /** Fixed-width text that wraps. */
  textBox(x: number, y: number, w: number, text: string, size: number, extra: Extra = {}) {
    const it = makeTextBox(x, y, w, text, size, extra);
    it.h = Math.ceil(measureTextHeight(text, w, size, "sans", !!extra.bold, !!extra.italic));
    return this.add(it);
  }

  card(x: number, y: number, title: string, extra: Extra = {}) {
    return this.add(makeCard(x, y, title, extra));
  }

  emoji(cx: number, cy: number, emoji: string, size = 72) {
    return this.add(makeEmoji(cx, cy, emoji, size));
  }

  connect(a: WbItem, as: Side | "auto", b: WbItem, bs: Side | "auto", kind: ConnectorKind = "elbow", endCap: Cap = "arrow", extra: Extra = {}) {
    return this.add(makeConnector({ id: a.id, side: as }, { id: b.id, side: bs }, kind, endCap, extra));
  }

  /** Free straight line (dividers, timelines). */
  line(x1: number, y1: number, x2: number, y2: number, extra: Extra = {}) {
    return this.add(makeConnector({ x: x1, y: y1 }, { x: x2, y: y2 }, "straight", "none", extra));
  }
}

/** Copies of the template's items, centred on (cx, cy). */
export function instantiate(t: WbTemplate, cx: number, cy: number): WbItem[] {
  const items = t.build();
  const boxes = items.filter((i) => i.type !== "connector").map((i) => geomBounds(i));
  const b = unionRects(boxes);
  if (!b) return items;
  const dx = cx - (b.x + b.w / 2);
  const dy = cy - (b.y + b.h / 2);
  const r = (n: number) => Math.round(n * 100) / 100;
  return items.map((it) => {
    if (it.type !== "connector") return { ...it, x: r(it.x + dx), y: r(it.y + dy) };
    const d = it.data as ConnectorData;
    const mv = (e?: ConnectorEnd) => (e && !e.id ? { ...e, x: r((e.x ?? 0) + dx), y: r((e.y ?? 0) + dy) } : e);
    return { ...it, data: { ...it.data, start: mv(d.start), end: mv(d.end) } };
  });
}

// ------------------------------------------------------------- templates --
const TOP = 170; // content starts below the heading and subtitle

function brainstorm(): WbItem[] {
  const b = new Builder();
  const W = 1500;
  const H = 1100;
  b.frameWith(W, H, "Brainstorm", "Write one idea per sticky note. Group similar ideas when you're done.");
  const cx = W / 2;
  const cy = 630;
  b.shape("ellipse", cx - 190, cy - 110, 380, 220, { fill: D_PURPLE, strokeWidth: 0, text: "What's the challenge?", fontSize: 28, bold: true });
  const colors = [YELLOW, ORANGE, PINK, PURPLE, BLUE, SKY, GREEN, LIME];
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 4;
    b.sticky(cx + Math.cos(a) * 520, cy + Math.sin(a) * 330, colors[i]!, "", 180);
  }
  return b.items;
}

function kanban(): WbItem[] {
  const b = new Builder();
  const colW = 360;
  const gap = 24;
  const cols: { name: string; fill: string; head: string; cards: [string, string, string][] }[] = [
    {
      name: "To do",
      fill: GREY,
      head: SLATE,
      cards: [
        ["Research competitors", "Compare pricing and key features.", ORANGE],
        ["Draft the project brief", "", YELLOW],
        ["Plan user interviews", "Five customers, 30 minutes each.", SKY],
      ],
    },
    {
      name: "In progress",
      fill: BLUE,
      head: D_BLUE,
      cards: [
        ["Design the landing page", "", PURPLE],
        ["Set up analytics", "Track sign-ups and activation.", BLUE],
      ],
    },
    { name: "Review", fill: PURPLE, head: D_PURPLE, cards: [["Write release notes", "", PINK]] },
    { name: "Done", fill: GREEN, head: D_GREEN, cards: [["Kickoff meeting", "", GREEN]] },
  ];
  const W = 120 + cols.length * colW + (cols.length - 1) * gap;
  const bodyH = 820;
  b.frameWith(W, TOP + 76 + bodyH + 60, "Kanban board", "Move cards across the columns as work moves forward.");
  cols.forEach((col, i) => {
    const x = 60 + i * (colW + gap);
    b.block(x, TOP, colW, 64, col.head, { text: col.name, fontSize: 22, bold: true });
    b.block(x, TOP + 76, colW, bodyH, col.fill, { opacity: 0.18 });
    col.cards.forEach(([title, description, fill], j) => {
      b.card(x + 20, TOP + 96 + j * 156, title, { fill, description, ...(col.name === "Done" ? { done: true } : {}) });
    });
  });
  return b.items;
}

function retrospective(): WbItem[] {
  const b = new Builder();
  const colW = 520;
  const gap = 30;
  const cols = [
    { name: "Went well", prompt: "What helped us succeed?", fill: GREEN, head: D_GREEN },
    { name: "To improve", prompt: "What slowed us down?", fill: RED, head: D_RED },
    { name: "Action items", prompt: "What will we try next?", fill: BLUE, head: D_BLUE },
  ];
  const bodyY = TOP + 92;
  const bodyH = 560;
  b.frameWith(120 + 3 * colW + 2 * gap, bodyY + bodyH + 60, "Retrospective", "Look back on the last sprint together, then vote on what to act on.");
  cols.forEach((col, i) => {
    const x = 60 + i * (colW + gap);
    b.block(x, TOP, colW, 80, col.head, { text: col.name, fontSize: 26, bold: true });
    b.block(x, bodyY, colW, bodyH, col.fill, { opacity: 0.16 });
    b.textBox(x + 24, bodyY + 22, colW - 48, col.prompt, 18, { align: "center" });
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) b.sticky(x + colW / 2 + (c ? 115 : -115), bodyY + 180 + r * 230, col.fill);
  });
  return b.items;
}

function mindMap(): WbItem[] {
  const b = new Builder();
  const root = b.block(0, -55, 280, 110, D_PURPLE, { text: "Main idea", fontSize: 28, bold: true });
  const branches: { text: string; fill: string; leaves: string[] }[] = [
    { text: "Goals", fill: BLUE, leaves: ["Grow sign-ups", "Faster onboarding"] },
    { text: "Ideas", fill: YELLOW, leaves: ["Referral program", "Weekly webinars"] },
    { text: "Resources", fill: GREEN, leaves: ["Design team", "Marketing budget"] },
    { text: "Risks", fill: RED, leaves: ["Tight deadline", "Limited data"] },
  ];
  const leafH = 56;
  const blockH = 2 * leafH + 24;
  const gap = 48;
  const total = branches.length * blockH + (branches.length - 1) * gap;
  branches.forEach((br, i) => {
    const top = -total / 2 + i * (blockH + gap);
    const node = b.block(420, top + blockH / 2 - 36, 220, 72, br.fill, { text: br.text, fontSize: 20, bold: true });
    // Mind-map links (data.mind) so Tab / Shift+Enter keep growing the tree.
    b.connect(root, "right", node, "left", "curved", "none", { mind: true, color: br.fill, width: 3 });
    br.leaves.forEach((t, j) => {
      const leaf = b.shape("round", 760, top + j * (leafH + 24), 200, leafH, { fill: "surface", stroke: br.fill, strokeWidth: 2, text: t, fontSize: 16 });
      b.connect(node, "right", leaf, "left", "curved", "none", { mind: true, color: br.fill, width: 2 });
    });
  });
  return b.items;
}

function flowchart(): WbItem[] {
  const b = new Builder();
  b.frameWith(1040, 1090, "Flowchart", "Map each step and decision in a process.");
  const cx = 400;
  const start = b.shape("ellipse", cx - 110, 180, 220, 90, { fill: GREEN, strokeWidth: 0, text: "Start", fontSize: 20, bold: true });
  const step1 = b.shape("round", cx - 130, 330, 260, 110, { text: "Receive the request", fontSize: 18 });
  const decide = b.shape("diamond", cx - 140, 500, 280, 170, { fill: YELLOW, strokeWidth: 0, text: "Is it complete?", fontSize: 18, bold: true });
  const step2 = b.shape("round", cx - 130, 740, 260, 110, { text: "Process the request", fontSize: 18 });
  const end = b.shape("ellipse", cx - 110, 920, 220, 90, { fill: RED, strokeWidth: 0, text: "End", fontSize: 20, bold: true });
  const fix = b.shape("round", cx + 260, 530, 260, 110, { fill: ORANGE, strokeWidth: 0, text: "Ask for the missing details", fontSize: 18 });
  b.connect(start, "bottom", step1, "top");
  b.connect(step1, "bottom", decide, "top");
  b.connect(decide, "bottom", step2, "top", "elbow", "arrow", { label: "Yes" });
  b.connect(decide, "right", fix, "left", "elbow", "arrow", { label: "No" });
  b.connect(fix, "top", step1, "right");
  b.connect(step2, "bottom", end, "top");
  return b.items;
}

/** 2x2 grid with axis labels (SWOT, Eisenhower). */
function matrix(
  title: string,
  subtitle: string,
  colLabels: [string, string],
  rowLabels: [string, string],
  quads: { title: string; prompt: string; fill: string }[],
): WbItem[] {
  const b = new Builder();
  const qw = 640;
  const qh = 460;
  const gap = 20;
  const x0 = 130;
  const y0 = TOP + 50;
  b.frameWith(x0 + 2 * qw + gap + 60, y0 + 2 * qh + gap + 60, title, subtitle);
  colLabels.forEach((t, c) => b.textAt(x0 + c * (qw + gap) + qw / 2, y0 - 26, t, 20, { bold: true }));
  rowLabels.forEach((t, r) => {
    const it = b.textAt(x0 - 36, y0 + r * (qh + gap) + qh / 2, t, 20, { bold: true });
    it.rotation = -90;
  });
  quads.forEach((q, i) => {
    const x = x0 + (i % 2) * (qw + gap);
    const y = y0 + Math.floor(i / 2) * (qh + gap);
    b.block(x, y, qw, qh, q.fill, { opacity: 0.2 });
    b.text(x + 28, y + 24, q.title, 28, { bold: true });
    b.textBox(x + 28, y + 72, qw - 56, q.prompt, 16);
    for (let s = 0; s < 3; s++) b.sticky(x + 28 + 80 + s * 184, y + qh - 28 - 80, q.fill, "", 160);
  });
  return b.items;
}

const swot = () =>
  matrix("SWOT analysis", "Weigh strengths, weaknesses, opportunities and threats.", ["Helpful", "Harmful"], ["Internal", "External"], [
    { title: "Strengths", prompt: "What do we do well? What makes us stand out?", fill: GREEN },
    { title: "Weaknesses", prompt: "Where can we improve? What do others do better?", fill: YELLOW },
    { title: "Opportunities", prompt: "Which trends or openings could we use?", fill: BLUE },
    { title: "Threats", prompt: "What could get in our way?", fill: RED },
  ]);

const eisenhower = () =>
  matrix("Eisenhower matrix", "Sort tasks by how urgent and how important they are.", ["Urgent", "Not urgent"], ["Important", "Not important"], [
    { title: "Do first", prompt: "Deadlines and crises. Do these today.", fill: RED },
    { title: "Schedule", prompt: "Plans and growth. Put these on the calendar.", fill: BLUE },
    { title: "Delegate", prompt: "Interruptions and busy work. Hand these off.", fill: YELLOW },
    { title: "Eliminate", prompt: "Distractions. Drop these.", fill: GREY },
  ]);

function weeklyPlanner(): WbItem[] {
  const b = new Builder();
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const colW = 260;
  const gap = 16;
  const bodyY = TOP + 76;
  const bodyH = 640;
  b.frameWith(120 + 7 * colW + 6 * gap, bodyY + bodyH + 60, "Weekly planner", "Plan the week day by day. Drag notes between days as plans change.");
  const notes: Record<number, [string, string]> = { 0: ["Plan the week", YELLOW], 2: ["Team sync", BLUE], 4: ["Weekly review", GREEN] };
  days.forEach((d, i) => {
    const x = 60 + i * (colW + gap);
    const weekend = i >= 5;
    b.block(x, TOP, colW, 64, weekend ? SLATE : D_BLUE, { text: d, fontSize: 22, bold: true });
    b.block(x, bodyY, colW, bodyH, weekend ? GREY : BLUE, { opacity: 0.14 });
    const n = notes[i];
    if (n) b.sticky(x + colW / 2, bodyY + 130, n[1], n[0], 200);
  });
  return b.items;
}

function storyMap(): WbItem[] {
  const b = new Builder();
  const x0 = 260;
  const colW = 360;
  const gap = 40;
  const size = 170;
  const W = x0 + 4 * colW + 3 * gap + 60;
  b.frameWith(W, 1030, "User story map", "Lay out the user journey, then slice stories into releases.");
  const activities: { name: string; steps: [string, string] }[] = [
    { name: "Discover", steps: ["Find us online", "Read reviews"] },
    { name: "Sign up", steps: ["Create an account", "Verify email"] },
    { name: "Use the product", steps: ["Create a project", "Invite the team"] },
    { name: "Get help", steps: ["Search the docs", "Contact support"] },
  ];
  const release1: Record<number, string> = { 0: "Landing page", 2: "Email sign-up", 4: "Basic projects", 6: "Help center" };
  const release2: Record<number, string> = { 1: "Reviews page", 3: "Social sign-in", 5: "Team invites", 7: "Live chat" };
  const rows = [
    { label: "Activities", cy: TOP + 45 },
    { label: "Steps", cy: 375 },
    { label: "Release 1", cy: 625 },
    { label: "Release 2", cy: 875 },
  ];
  rows.forEach((r) => {
    const it = b.text(60, 0, r.label, 20, { bold: true });
    it.y = r.cy - it.h / 2;
  });
  b.line(60, 500, W - 60, 500, { color: GREY, dash: "dashed" });
  b.line(60, 750, W - 60, 750, { color: GREY, dash: "dashed" });
  activities.forEach((a, i) => {
    const x = x0 + i * (colW + gap);
    b.block(x, TOP, colW, 90, D_ORANGE, { text: a.name, fontSize: 22, bold: true });
    a.steps.forEach((s, j) => {
      const cx = x + size / 2 + j * (size + 20);
      const k = i * 2 + j;
      b.sticky(cx, 375, BLUE, s, size);
      if (release1[k]) b.sticky(cx, 625, YELLOW, release1[k], size);
      if (release2[k]) b.sticky(cx, 875, LIME, release2[k], size);
    });
  });
  return b.items;
}

function journeyMap(): WbItem[] {
  const b = new Builder();
  const x0 = 260;
  const colW = 300;
  const gap = 10;
  const W = x0 + 5 * colW + 4 * gap + 60;
  b.frameWith(W, 1270, "Customer journey map", "Follow one customer through every stage. Note what they do, feel and need.");
  const stages = [
    { name: "Awareness", fill: D_BLUE, mood: "🤔" },
    { name: "Consideration", fill: D_PURPLE, mood: "🙂" },
    { name: "Purchase", fill: D_PINK, mood: "😀" },
    { name: "Retention", fill: D_SKY, mood: "😕" },
    { name: "Advocacy", fill: D_GREEN, mood: "😍" },
  ];
  const rows: { label: string; h: number; fill?: string }[] = [
    { label: "Actions", h: 200, fill: YELLOW },
    { label: "Touchpoints", h: 200, fill: SKY },
    { label: "Emotions", h: 120 },
    { label: "Pain points", h: 200, fill: RED },
    { label: "Opportunities", h: 200, fill: GREEN },
  ];
  stages.forEach((s, i) => b.shape("chevron", x0 + i * (colW + gap), TOP, colW, 90, { fill: s.fill, strokeWidth: 0, text: s.name, fontSize: 17, bold: true }));
  let top = TOP + 120;
  for (const r of rows) {
    b.line(60, top, W - 60, top, { color: GREY, dash: "dashed", width: 1 });
    const label = b.text(60, 0, r.label, 20, { bold: true });
    label.y = top + r.h / 2 - label.h / 2;
    stages.forEach((s, i) => {
      const cx = x0 + i * (colW + gap) + colW / 2;
      if (r.fill) b.sticky(cx, top + r.h / 2, r.fill, "", 160);
      else b.emoji(cx, top + r.h / 2, s.mood, 72);
    });
    top += r.h;
  }
  return b.items;
}

function leanCanvas(): WbItem[] {
  const b = new Builder();
  const u = 320;
  const rh = 280;
  b.frameWith(120 + 5 * u, TOP + 3 * rh + 60, "Lean canvas", "Capture your business model on one page.");
  const cells: [string, string, number, number, number, number][] = [
    ["Problem", "Top 3 problems", 0, 0, 1, 2],
    ["Solution", "Top 3 features", 1, 0, 1, 1],
    ["Key metrics", "Key activities you measure", 1, 1, 1, 1],
    ["Unique value proposition", "One clear message that says why you are different and worth buying", 2, 0, 1, 2],
    ["Unfair advantage", "Something that can't easily be copied or bought", 3, 0, 1, 1],
    ["Channels", "Your path to customers", 3, 1, 1, 1],
    ["Customer segments", "Target customers and early adopters", 4, 0, 1, 2],
    ["Cost structure", "Customer acquisition, distribution, hosting, people", 0, 2, 2.5, 1],
    ["Revenue streams", "Revenue model, lifetime value, gross margin", 2.5, 2, 2.5, 1],
  ];
  for (const [title, hint, cx, cy, cw, ch] of cells) {
    const x = 60 + cx * u;
    const y = TOP + cy * rh;
    const w = cw * u;
    b.shape("rect", x, y, w, ch * rh, { fill: "surface", stroke: GREY, strokeWidth: 2 });
    const t = b.textBox(x + 20, y + 18, w - 40, title, 20, { bold: true });
    b.textBox(x + 20, t.y + t.h + 8, w - 40, hint, 15);
  }
  return b.items;
}

function empathyMap(): WbItem[] {
  const b = new Builder();
  const qw = 560;
  const qh = 400;
  const gap = 16;
  const x0 = 60;
  const y0 = TOP;
  const W = x0 * 2 + 2 * qw + gap;
  const bottomY = y0 + 2 * qh + 2 * gap;
  b.frameWith(W, bottomY + 240 + 60, "Empathy map", "Step into your user's shoes. What do they say, think, do and feel?");
  const quads = [
    { title: "Says", prompt: "Quotes and things they said out loud", fill: BLUE },
    { title: "Thinks", prompt: "What occupies their thoughts?", fill: PURPLE },
    { title: "Does", prompt: "Actions and habits you notice", fill: GREEN },
    { title: "Feels", prompt: "Worries, hopes and emotions", fill: PINK },
  ];
  quads.forEach((q, i) => {
    const right = i % 2 === 1;
    const x = x0 + (right ? qw + gap : 0);
    const y = y0 + Math.floor(i / 2) * (qh + gap);
    b.block(x, y, qw, qh, q.fill, { opacity: 0.18 });
    // Text sits on the outer side, clear of the user circle in the middle.
    const t = b.text(x + 28, y + 24, q.title, 26, { bold: true, align: right ? "right" : "left" });
    if (right) t.x = x + qw - 28 - t.w;
    b.textBox(right ? x + qw / 2 : x + 28, y + 70, qw / 2 - 28, q.prompt, 15, { align: right ? "right" : "left" });
    for (let s = 0; s < 2; s++) b.sticky(right ? x + qw - 100 - s * 180 : x + 100 + s * 180, y + 250, q.fill, "", 150);
  });
  const cx = x0 + qw + gap / 2;
  const cy = y0 + qh + gap / 2;
  b.shape("ellipse", cx - 110, cy - 110, 220, 220, { fill: "surface", stroke: "ink", strokeWidth: 2, text: "User name", fontSize: 18, bold: true, valign: "bottom" });
  b.emoji(cx, cy - 26, "🙂", 72);
  const halves = [
    { title: "Pains", prompt: "Fears, frustrations and obstacles", fill: RED },
    { title: "Gains", prompt: "Wants, needs and measures of success", fill: GREEN },
  ];
  const hw = (2 * qw + gap - gap) / 2;
  halves.forEach((hf, i) => {
    const x = x0 + i * (hw + gap);
    b.block(x, bottomY, hw, 240, hf.fill, { opacity: 0.18 });
    b.text(x + 28, bottomY + 24, hf.title, 26, { bold: true });
    b.textBox(x + 28, bottomY + 70, hw - 56, hf.prompt, 15);
  });
  return b.items;
}

function timeline(): WbItem[] {
  const b = new Builder();
  const W = 2060;
  const lineY = 470;
  b.frameWith(W, 690, "Project timeline", "Plan milestones and phases. Drag them as dates move.");
  b.line(100, lineY, W - 100, lineY, { color: "ink", width: 4, endCap: "triangle" });
  const phases = [
    { name: "Discovery", x: 140, w: 400, fill: BLUE },
    { name: "Design", x: 560, w: 400, fill: PURPLE },
    { name: "Build", x: 980, w: 560, fill: ORANGE },
    { name: "Launch", x: 1560, w: 340, fill: GREEN },
  ];
  for (const p of phases) b.block(p.x, lineY + 34, p.w, 56, p.fill, { text: p.name, fontSize: 18, bold: true });
  ["Jan", "Feb", "Mar", "Apr", "May", "Jun"].forEach((m, i) => b.textAt(200 + i * 330, lineY + 124, m, 16));
  const milestones = [
    { name: "Kickoff", x: 200, fill: D_BLUE, note: YELLOW },
    { name: "Research done", x: 620, fill: D_PURPLE, note: PINK },
    { name: "Design sign-off", x: 1040, fill: D_ORANGE, note: ORANGE },
    { name: "Beta release", x: 1440, fill: D_RED, note: SKY },
    { name: "Launch day", x: 1800, fill: D_GREEN, note: GREEN },
  ];
  for (const m of milestones) {
    const dot = b.shape("diamond", m.x - 18, lineY - 18, 36, 36, { fill: m.fill, strokeWidth: 0 });
    const note = b.sticky(m.x, lineY - 70 - 85, m.note, m.name, 170);
    b.connect(note, "bottom", dot, "top", "straight", "none", { color: GREY, dash: "dotted" });
  }
  return b.items;
}

function icebreaker(): WbItem[] {
  const b = new Builder();
  const size = 200;
  const gap = 30;
  const W = 120 + 5 * size + 4 * gap;
  b.frameWith(W, 830, "Icebreaker", "Grab a sticky note, add your name and one fun fact about you.");
  b.emoji(W - 120, 90, "👋", 96);
  const colors = [YELLOW, ORANGE, PINK, PURPLE, BLUE, SKY, GREEN, LIME, RED, YELLOW];
  for (let i = 0; i < 10; i++) {
    const c = i % 5;
    const r = Math.floor(i / 5);
    b.sticky(60 + size / 2 + c * (size + gap), TOP + 30 + size / 2 + r * (size + gap), colors[i]!, "", size);
  }
  ["🎉", "☕", "🌍", "🎵", "🍕"].forEach((e, i) => b.emoji(60 + size / 2 + i * (size + gap), 730, e, 64));
  return b.items;
}

/**
 * Content plan (the Miro reels board): one frame per video, stacked under each
 * other, each with the brief on the left and the reference video on the right.
 * "Add next" on a frame adds the following one.
 */
function contentPlan(): WbItem[] {
  const b = new Builder();
  const W = 1200;
  const H = 780;
  const GAP = 120;
  const fields: [string, string][] = [
    ["Concept", "What is this video about?"],
    ["Hook (first 3 seconds)", "The line or shot that stops the scroll."],
    ["Script and shots", "1.  Opening shot\n2.  Main part\n3.  Call to action"],
    ["Products", "Product name and link"],
    ["Caption and hashtags", "Caption text  #hashtag"],
  ];
  for (let i = 0; i < 4; i++) {
    const y = i * (H + GAP);
    const n = String(i + 1).padStart(2, "0");
    b.frameAt(0, y, W, H, `Reel - ${n}`);
    b.text(60, y + 48, `Reel - ${n}`, 40, { bold: true });
    let fy = y + 132;
    for (const [label, hint] of fields) {
      b.text(60, fy, label, 20, { bold: true });
      const body = b.textBox(60, fy + 34, 640, hint, 18, { color: "#8590a2" });
      fy += 34 + body.h + 32;
    }
    b.embed(W - 60 - 360, y + 60, 360, H - 120);
  }
  return b.items;
}

export const TEMPLATES: WbTemplate[] = [
  { id: "content", name: "Content plan", description: "One frame per video, stacked. Brief plus a playable reference.", build: contentPlan },
  { id: "brainstorm", name: "Brainstorm", description: "Gather ideas around one question.", build: brainstorm },
  { id: "kanban", name: "Kanban board", description: "Track work from to do to done.", build: kanban },
  { id: "retro", name: "Retrospective", description: "What went well and what to improve.", build: retrospective },
  { id: "mindmap", name: "Mind map", description: "Branch out ideas. Tab adds a child.", build: mindMap },
  { id: "flowchart", name: "Flowchart", description: "Map the steps and decisions in a process.", build: flowchart },
  { id: "swot", name: "SWOT analysis", description: "Strengths, weaknesses, opportunities, threats.", build: swot },
  { id: "eisenhower", name: "Eisenhower matrix", description: "Sort tasks by urgency and importance.", build: eisenhower },
  { id: "weekly", name: "Weekly planner", description: "Plan the week day by day.", build: weeklyPlanner },
  { id: "storymap", name: "User story map", description: "Lay out the journey, slice releases.", build: storyMap },
  { id: "journey", name: "Customer journey map", description: "Follow a customer through each stage.", build: journeyMap },
  { id: "lean", name: "Lean canvas", description: "Your business model on one page.", build: leanCanvas },
  { id: "empathy", name: "Empathy map", description: "What users say, think, do and feel.", build: empathyMap },
  { id: "timeline", name: "Project timeline", description: "Milestones and phases along one line.", build: timeline },
  { id: "icebreaker", name: "Icebreaker", description: "Warm up the team before a session.", build: icebreaker },
];
