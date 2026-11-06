// What Nabil sets without code, from WhatsApp (and later the dashboard): the
// default model by workflow, task type, user or for everything; instructions,
// language, tone, autonomy, guardrails, workflows, memory, spend limits.
// Pure functions over one settings object; the relay saves it and keeps the
// earlier versions for /undo.

export const WORKERS = ["claude", "gpt", "grok"];
export const TASK_TYPES = ["code", "research", "writing", "data", "other"];
export const AUTONOMY = {
  "ask-all": "Ask before every action: make a plan, wait for Nabil's go.",
  "ask-sensitive": "Act on your own; only the guardrails list needs his yes.",
  "do-and-report": "Act on your own and report what you did; only the guardrails list needs his yes.",
};

export function defaultSettings() {
  return {
    defaults: { global: "claude", taskType: {}, workflow: {}, user: {} },
    central: { provider: "claude", model: "opus" },
    instructions: { all: "", claude: "", gpt: "", grok: "" },
    language: "English",
    tone: "short and direct",
    autonomy: "ask-sensitive",
    guardrails: [
      "deploying or publishing anything",
      "merging or force-pushing code",
      "deleting files, data, repos or accounts",
      "spending money or buying anything",
      "sending messages or emails to anyone outside this chat",
      "changing server, DNS or account settings",
    ],
    workflows: {},
    memory: [],
    limits: {},
    paused: [],
  };
}

/** Settings read back from disk, with anything new filled in. */
export function withDefaults(s) {
  const d = defaultSettings();
  const out = { ...d, ...(s ?? {}) };
  out.defaults = { ...d.defaults, ...(s?.defaults ?? {}) };
  out.instructions = { ...d.instructions, ...(s?.instructions ?? {}) };
  out.central = { ...d.central, ...(s?.central ?? {}) };
  return out;
}

/** The model for a request, first match wins: the chat, its workflow, the task type, the user, everything. */
export function pickProvider({ chat, workflow, taskType, user, settings }) {
  const d = settings.defaults;
  if (chat) return { provider: chat, why: "this chat" };
  const wf = workflow && (settings.workflows[workflow]?.provider ?? d.workflow[workflow]);
  if (wf) return { provider: wf, why: `workflow ${workflow}` };
  if (taskType && d.taskType[taskType]) return { provider: d.taskType[taskType], why: `${taskType} tasks` };
  if (user && d.user[user]) return { provider: d.user[user], why: "your default" };
  return { provider: d.global, why: "the default" };
}

/** Whether a request needs to know its task type to pick (so the router only runs when it matters). */
export const needsTaskType = (settings) => Object.keys(settings.defaults.taskType).length > 0;

/** The instructions a worker gets, built from the settings each time (so a change applies at once). */
export function systemFor(settings, provider, base) {
  const s = settings;
  const parts = [
    base,
    `Write your replies in ${s.language}, whatever language the message is in.`,
    `Tone: ${s.tone}.`,
    `Autonomy: ${AUTONOMY[s.autonomy] ?? AUTONOMY["ask-sensitive"]}`,
    `Guardrails: ${s.guardrails.join("; ")}. Through the brain, the bot decides what needs his go: never ask in words as well. Anything of these not through the brain: say in one line what you'll do and wait for his yes.`,
  ];
  if (s.instructions.all) parts.push(`Nabil's instructions: ${s.instructions.all}`);
  if (s.instructions[provider]) parts.push(`Nabil's instructions for you: ${s.instructions[provider]}`);
  if (s.memory.length) parts.push(`What Nabil asked you to remember:\n- ${s.memory.map((m) => m.text).join("\n- ")}`);
  return parts.join("\n");
}

/** "$5" -> {usd: 5}; "500k" / "2m" / "20000" -> {tokens}; else null. */
export function parseAmount(s) {
  const t = String(s ?? "").trim().toLowerCase().replace(/,/g, "");
  let m = /^\$\s*(\d+(?:\.\d+)?)$/.exec(t) ?? /^(\d+(?:\.\d+)?)\s*(usd|dollars?)$/.exec(t);
  if (m) return { usd: Number(m[1]) };
  m = /^(\d+(?:\.\d+)?)\s*([km]?)\s*(tokens?)?$/.exec(t);
  if (m) return { tokens: Math.round(Number(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1)) };
  return null;
}

const amountText = (a) => (a?.usd != null ? `$${a.usd}` : a?.tokens != null ? `${a.tokens.toLocaleString("en-US")} tokens` : "none");
const workerOf = (w) => ({ claude: "claude", anthropic: "claude", gpt: "gpt", codex: "gpt", openai: "gpt", chatgpt: "gpt", grok: "grok", xai: "grok" })[String(w ?? "").toLowerCase()] ?? null;
const numbered = (items, f = (x) => x) => (items.length ? items.map((x, i) => `${i + 1}. ${f(x)}`).join("\n") : "(none)");

/** The settings commands, as `/name arg`. Each returns {reply} or {reply, next, what} when it changes something. */
export const SETTINGS_COMMANDS = new Set(["instructions", "language", "tone", "autonomy", "guardrails", "workflows", "memory", "default", "limits", "central", "settings"]);

export function settingsCommand(name, arg, current, { user } = {}) {
  const s = structuredClone(current);
  const words = arg.split(/\s+/).filter(Boolean);
  const done = (what, reply) => ({ next: s, what, reply: `✅ ${reply}` });
  switch (name) {
    case "settings":
      return {
        reply: [
          `*Settings*`,
          `Default: ${s.defaults.global}${Object.keys(s.defaults.taskType).length ? ` · by task: ${Object.entries(s.defaults.taskType).map(([k, v]) => `${k}→${v}`).join(", ")}` : ""}`,
          `Central agent: ${s.central.provider}${s.central.model ? ` (${s.central.model})` : ""}`,
          `Language: ${s.language} · Tone: ${s.tone} · Autonomy: ${s.autonomy}`,
          `Guardrails: ${s.guardrails.length} · Workflows: ${Object.keys(s.workflows).length} · Memory: ${s.memory.length}`,
          `Instructions: ${s.instructions.all ? "set" : "none"}${WORKERS.filter((w) => s.instructions[w]).map((w) => ` · ${w}: set`).join("")}`,
        ].join("\n"),
      };
    case "instructions": {
      if (!arg) return { reply: `*Instructions*\nAll: ${s.instructions.all || "(none)"}\n${WORKERS.map((w) => `${w}: ${s.instructions[w] || "(none)"}`).join("\n")}` };
      if (words[0] === "clear") {
        const w = workerOf(words[1]);
        if (w) s.instructions[w] = "";
        else s.instructions.all = "";
        return done("instructions", `Instructions cleared${w ? ` for ${w}` : ""}.`);
      }
      const w = workerOf(words[0]);
      const text = w ? arg.slice(words[0].length).trim() : arg;
      if (!text) return { reply: "/instructions [claude|gpt|grok] text · /instructions clear [worker]" };
      s.instructions[w ?? "all"] = text.slice(0, 4000);
      return done("instructions", `Instructions set${w ? ` for ${w}` : ""}.`);
    }
    case "language":
      if (!arg) return { reply: `Language: ${s.language}` };
      s.language = arg.slice(0, 40);
      return done("language", `Replies in ${s.language} from now on.`);
    case "tone":
      if (!arg) return { reply: `Tone: ${s.tone}` };
      s.tone = arg.slice(0, 200);
      return done("tone", `Tone: ${s.tone}.`);
    case "autonomy":
      if (!AUTONOMY[arg]) return { reply: `Autonomy: ${s.autonomy}\n/autonomy ask-all | ask-sensitive | do-and-report` };
      s.autonomy = arg;
      return done("autonomy", `Autonomy: ${arg}.`);
    case "guardrails": {
      if (!arg) return { reply: `*Always asks first before*\n${numbered(s.guardrails)}\n\n/guardrails add text · /guardrails remove number` };
      if (words[0] === "add" && words.length > 1) {
        s.guardrails.push(arg.slice(4).trim().slice(0, 200));
        return done("guardrails", `Guardrail added: ${s.guardrails.at(-1)}`);
      }
      const n = Number(words[1]);
      if (words[0] === "remove" && s.guardrails[n - 1]) {
        const [gone] = s.guardrails.splice(n - 1, 1);
        return done("guardrails", `Guardrail removed: ${gone}`);
      }
      return { reply: "/guardrails add text · /guardrails remove number" };
    }
    case "workflows": {
      const names = Object.keys(s.workflows);
      if (!arg) return { reply: `*Workflows*\n${names.length ? names.map((n) => `${n}: ${s.workflows[n].steps.join(" → ")}${s.workflows[n].provider ? ` (${s.workflows[n].provider})` : ""}`).join("\n") : "(none)"}\n\n/workflows add name: step > step > step\n/workflows default name worker\n/workflows remove name\n/run name request` };
      if (words[0] === "add") {
        const m = /^add\s+([\w-]+)\s*:\s*(.+)$/s.exec(arg);
        if (!m) return { reply: "/workflows add name: step > step > step" };
        const steps = m[2].split(/\s*(?:>|→|->)\s*/).map((x) => x.trim()).filter(Boolean).slice(0, 12);
        s.workflows[m[1].toLowerCase()] = { steps, provider: s.workflows[m[1].toLowerCase()]?.provider ?? null };
        return done("workflows", `Workflow ${m[1].toLowerCase()}: ${steps.join(" → ")}`);
      }
      if (words[0] === "default" && s.workflows[words[1]?.toLowerCase()] && workerOf(words[2])) {
        s.workflows[words[1].toLowerCase()].provider = workerOf(words[2]);
        return done("workflows", `Workflow ${words[1].toLowerCase()} uses ${workerOf(words[2])}.`);
      }
      if (words[0] === "remove" && s.workflows[words[1]?.toLowerCase()]) {
        delete s.workflows[words[1].toLowerCase()];
        return done("workflows", `Workflow ${words[1].toLowerCase()} removed.`);
      }
      return { reply: "/workflows add name: step > step · /workflows default name worker · /workflows remove name" };
    }
    case "memory": {
      if (!arg) return { reply: `*Memory* (every model reads it)\n${numbered(s.memory, (m) => m.text)}\n\n/memory add text · /memory edit number text · /memory forget number` };
      const n = Number(words[1]);
      if (words[0] === "add" && words.length > 1) {
        s.memory.push({ text: arg.slice(4).trim().slice(0, 1000), at: Date.now() });
        return done("memory", `Remembered: ${s.memory.at(-1).text}`);
      }
      if (words[0] === "edit" && s.memory[n - 1] && words.length > 2) {
        s.memory[n - 1] = { text: arg.replace(/^edit\s+\d+\s+/, "").slice(0, 1000), at: Date.now() };
        return done("memory", `Memory ${n}: ${s.memory[n - 1].text}`);
      }
      if (words[0] === "forget" && s.memory[n - 1]) {
        const [gone] = s.memory.splice(n - 1, 1);
        return done("memory", `Forgot: ${gone.text}`);
      }
      return { reply: "/memory add text · /memory edit number text · /memory forget number" };
    }
    case "default": {
      const d = s.defaults;
      if (!arg)
        return {
          reply: [
            `*Default model* (first match wins: chat → workflow → task type → user → everything)`,
            `Everything: ${d.global}`,
            `By task type: ${Object.entries(d.taskType).map(([k, v]) => `${k}→${v}`).join(", ") || "(none)"}`,
            `By workflow: ${Object.entries(s.workflows).filter(([, w]) => w.provider).map(([k, w]) => `${k}→${w.provider}`).join(", ") || "(none)"}`,
            `By user: ${Object.entries(d.user).map(([k, v]) => `${k}→${v}`).join(", ") || "(none)"}`,
            "",
            "/default worker · /default code|research|writing|data|other worker|off · /default workflow name worker · /default user worker",
          ].join("\n"),
        };
      const w0 = workerOf(words[0]);
      if (w0 && words.length === 1) {
        d.global = w0;
        return done("default", `Default for everything: ${w0}.`);
      }
      if (TASK_TYPES.includes(words[0])) {
        if (words[1] === "off") delete d.taskType[words[0]];
        else if (workerOf(words[1])) d.taskType[words[0]] = workerOf(words[1]);
        else return { reply: `/default ${words[0]} claude|gpt|grok|off` };
        return done("default", `${words[0]} tasks: ${d.taskType[words[0]] ?? "the default"}.`);
      }
      if (words[0] === "workflow" && s.workflows[words[1]?.toLowerCase()] && workerOf(words[2])) {
        s.workflows[words[1].toLowerCase()].provider = workerOf(words[2]);
        return done("default", `Workflow ${words[1].toLowerCase()}: ${workerOf(words[2])}.`);
      }
      if (words[0] === "user" && user && (workerOf(words[1]) || words[1] === "off")) {
        if (words[1] === "off") delete d.user[user];
        else d.user[user] = workerOf(words[1]);
        return done("default", `Your default: ${d.user[user] ?? "the default"}.`);
      }
      return { reply: "/default worker · /default code gpt · /default workflow name worker · /default user worker" };
    }
    case "central": {
      const w = workerOf(words[0]);
      if (!w) return { reply: `Central agent: ${s.central.provider}${s.central.model ? ` (${s.central.model})` : ""}\n/central claude|gpt|grok [model]` };
      s.central = { provider: w, model: words[1] ?? null };
      return done("central", `Central agent: ${w}${words[1] ? ` (${words[1]})` : ""}.`);
    }
    case "limits": {
      if (!arg)
        return {
          reply: `*Limits* (in tokens: all are subscriptions)\n${WORKERS.map((w) => `${w}: day ${amountText(s.limits[w]?.day)} · week ${amountText(s.limits[w]?.week)}${s.paused.includes(w) ? " · PAUSED" : ""}`).join("\n")}\n\n/limits worker day|week 500k · /limits worker off · /limits pause worker · /limits unpause worker`,
        };
      if (words[0] === "pause" || words[0] === "unpause") {
        const w = workerOf(words[1]) ?? (words[1] === "jev" ? "jev" : null);
        if (!w) return { reply: `/limits ${words[0]} claude|gpt|grok|jev` };
        s.paused = words[0] === "pause" ? [...new Set([...s.paused, w])] : s.paused.filter((x) => x !== w);
        return done("limits", `${w} ${words[0] === "pause" ? "paused" : "running again"}.`);
      }
      const w = workerOf(words[0]) ?? (words[0] === "jev" ? "jev" : null);
      if (!w) return { reply: "/limits worker day|week amount" };
      if (words[1] === "off") {
        delete s.limits[w];
        return done("limits", `No limits for ${w}.`);
      }
      const amount = parseAmount(words.slice(2).join(" "));
      // Subscriptions: limits in tokens only, never money.
      if (!["day", "week"].includes(words[1]) || !amount || amount.usd != null) return { reply: "/limits gpt week 2m · /limits grok day 500k (tokens)" };
      s.limits[w] = { ...(s.limits[w] ?? {}), [words[1]]: amount };
      return done("limits", `${w}: ${words[1]} limit ${amountText(amount)}.`);
    }
  }
  return { reply: "?" };
}
