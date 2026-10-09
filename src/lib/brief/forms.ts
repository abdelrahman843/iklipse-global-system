// -----------------------------------------------------------------------------
// Brief forms: the questions a brief link asks. A link keeps a copy of its
// form (brief_link.questions) from the moment it's made, so editing a form
// here never changes links already sent. The database checks the same rules
// as answered() below before it accepts the answers (_brief_answered, 0050).
// -----------------------------------------------------------------------------

export interface BriefField {
  key: string;
  label: string;
  /** Shown faintly under the label: what we mean, or an example. */
  hint?: string;
  long?: boolean;
}

interface Base {
  key: string;
  label: string;
  hint?: string;
}

export type BriefQuestion =
  | (Base & { type: "text" | "long"; placeholder?: string })
  | (Base & { type: "scale"; pairs: { key: string; left: string; right: string }[] })
  | (Base & { type: "fields"; fields: BriefField[]; kind?: "promise" })
  | (Base & { type: "repeat"; count: number; item: string; fields: BriefField[] })
  | (Base & { type: "images"; min: number; max: number });

export interface BriefSection {
  id: string;
  title: string;
  /** The right-hand side of the outline ("Core ethos of your brand"). */
  about: string;
  intro: string;
  examples?: { title: string; quote: string }[];
  questions: BriefQuestion[];
}

export interface BriefForm {
  key: string;
  title: string;
  version: number;
  /** "About 30 minutes" on the welcome screen. */
  minutes: number;
  sections: BriefSection[];
}

export type BriefAnswers = Record<string, unknown>;

/** Moodboard image: a file in the private 'brief' bucket. */
export interface BriefImage {
  path: string;
  name?: string;
}

// ------------------------------------------------------- Brand Workshop --
export const BRAND_WORKSHOP: BriefForm = {
  key: "brand_workshop",
  title: "Brand Workshop",
  version: 1,
  minutes: 35,
  sections: [
    {
      id: "introduction",
      title: "Introduction",
      about: "Who you are",
      intro:
        "Give us an overview of what your brand or business does or intends to do, the market you operate in, and a bit of the backstory behind your brand.",
      questions: [
        { key: "brand_name", type: "text", label: "Brand / business name" },
        { key: "description", type: "long", label: "Brief description", hint: "What does the business do, or intend to do?" },
        { key: "market", type: "long", label: "Market / industry", hint: "Where do you operate?" },
        { key: "backstory", type: "long", label: "Backstory / history", hint: "How it started and how it got here." },
      ],
    },
    {
      id: "purpose",
      title: "Brand purpose & values",
      about: "Core ethos of your brand",
      intro:
        "The core ethos of your brand, answering the question: what drives us beyond monetary gains? It captures the fundamental purpose for the company's existence.",
      questions: [
        {
          key: "existence",
          type: "long",
          label: "What justifies the existence of the brand?",
          hint: "The fundamental reason the brand exists, beyond conventional business metrics.",
        },
        {
          key: "impact",
          type: "long",
          label: "How is the brand making an impact?",
          hint: "How the brand is driving change and shaping the world of its customers.",
        },
        {
          key: "beliefs",
          type: "long",
          label: "What are the brand's core beliefs?",
          hint: "The main guiding principles behind the brand's actions and decisions.",
        },
        {
          key: "convictions",
          type: "long",
          label: "Articulate your unique convictions",
          hint: "Which beliefs set your brand apart in the market, what makes you stand out, and why your audience prefers you.",
        },
      ],
    },
    {
      id: "vision",
      title: "Vision and mission",
      about: "Future perception and key objectives",
      intro:
        "The vision is how the brand will be seen in the future, the company's North Star. The mission is the brand's steady commitment to reaching its key objectives.",
      examples: [
        {
          title: "Nike's mission",
          quote: "To bring inspiration and innovation to every athlete* in the world. (*If you have a body, you are an athlete.)",
        },
        {
          title: "Tesla's vision",
          quote: "To create the most compelling car company of the 21st century by driving the world's transition to electric vehicles.",
        },
      ],
      questions: [
        {
          key: "vision",
          type: "long",
          label: "Vision: goals and objectives",
          hint: "How will the brand impact the industry and its customers in the future?",
        },
        { key: "mission", type: "long", label: "Mission", hint: "What commitment can the brand make to its audience now?" },
      ],
    },
    {
      id: "promise",
      title: "What is your brand promise?",
      about: "Brand impact and commitment",
      intro:
        "A brand promise is the value or experience customers can expect every time they deal with the company. The better a company delivers on that promise, the stronger the brand in its customers' minds.",
      questions: [
        { key: "usp", type: "long", label: "Unique selling point", hint: "What does your brand offer that no competitor does?" },
        {
          key: "market_definition",
          type: "long",
          label: "Market definition",
          hint: "What will define your brand in the marketplace? What will your audience say about you?",
        },
        { key: "relevance", type: "long", label: "Relevance", hint: "Why are you relevant? What value do you bring to your niche or market?" },
        {
          key: "brand_promise",
          type: "fields",
          kind: "promise",
          label: "Brand promise",
          hint: "Complete these sentences to narrow your promise down to one clear phrase.",
          fields: [
            { key: "only", label: "The only", hint: "WHAT. For Apple: “The only technology giant”" },
            { key: "that", label: "That", hint: "CATEGORY, what you do: “That innovates user-friendly devices”" },
            { key: "for", label: "For", hint: "WHO, the customer: “For everyday users”" },
            { key: "in", label: "In", hint: "WHERE: “In the global market”" },
            { key: "era", label: "In an era of", hint: "WHEN: “In an era of over-complicated tech”" },
          ],
        },
      ],
    },
    {
      id: "audience",
      title: "Define your target audience",
      about: "Your valued customers",
      intro: "What unites them, who your most valued customers are, and what you set out to do for them.",
      questions: [
        { key: "themes", type: "long", label: "Themes", hint: "The traits and characteristics they share." },
        {
          key: "icp",
          type: "long",
          label: "Ideal customer profile (ICP)",
          hint: "Your ideal customer: their key characteristics, behaviours and needs.",
        },
        {
          key: "pain_points",
          type: "long",
          label: "Pain points",
          hint: "What challenges or problems does your ideal customer face?",
        },
        {
          key: "value_prop",
          type: "long",
          label: "Value proposition",
          hint: "What value do you give your ideal customer? How do you attract them and add to their lives?",
        },
      ],
    },
    {
      id: "voice",
      title: "Voice scale",
      about: "Personality of the brand",
      intro: "This scale helps us find the personality of the brand and a distinctive tone of voice. Pick a point on each line.",
      questions: [
        {
          key: "voice_scale",
          type: "scale",
          label: "Where does your brand sit?",
          hint: "The closer to a word, the more your brand is like it. The middle means both, equally.",
          pairs: [
            { key: "casual_formal", left: "Casual", right: "Formal" },
            { key: "playful_serious", left: "Humorous / playful", right: "Serious" },
            { key: "relaxed_technical", left: "Relaxed", right: "Technical / professional" },
            { key: "youthful_mature", left: "Youthful", right: "Mature" },
            { key: "friendly_exclusive", left: "Friendly", right: "Exclusive" },
            { key: "sassy_respectful", left: "Sassy / attitude", right: "Respectful" },
            { key: "bold_subtle", left: "Bold", right: "Subtle" },
            { key: "inspiring_informative", left: "Enthusiastic / inspiring", right: "Informative" },
            { key: "feminine_masculine", left: "Feminine", right: "Masculine" },
            { key: "innovative_traditional", left: "Innovative", right: "Traditional" },
            { key: "personal_impersonal", left: "Personal", right: "Impersonal" },
          ],
        },
      ],
    },
    {
      id: "brand",
      title: "Define your brand",
      about: "Your brand's environment",
      intro:
        "The behaviours and values your community practises, and the feelings they carry. What do people like “us” do? A few points for each, so we can start building a picture of the brand we want to create.",
      questions: [
        { key: "culture", type: "long", label: "Culture", hint: "What behaviours and values does your community practise?" },
        { key: "audience", type: "long", label: "Audience", hint: "Who is your target audience? What are their key characteristics?" },
        { key: "voice", type: "long", label: "Voice", hint: "What tone and style of communication does your brand use?" },
        {
          key: "feeling",
          type: "long",
          label: "Feeling",
          hint: "What emotions should your audience feel when they deal with your brand?",
        },
        {
          key: "brand_impact",
          type: "long",
          label: "Impact",
          hint: "What difference does your brand make in the lives of your audience and the wider world?",
        },
      ],
    },
    {
      id: "competitors",
      title: "Define your competitors",
      about: "What is and isn't working",
      intro: "Who are they? What are they doing that is, and isn't, working?",
      questions: [
        {
          key: "competitors",
          type: "repeat",
          count: 3,
          item: "Competitor",
          label: "Your three closest competitors",
          fields: [
            { key: "name", label: "Name" },
            { key: "market", label: "Market" },
            { key: "does", label: "What they do", long: true },
            { key: "works", label: "What works", long: true },
            { key: "doesnt", label: "What doesn't work", long: true },
          ],
        },
      ],
    },
    {
      id: "look",
      title: "Look and feel",
      about: "Attract your audience",
      intro: "How do we need to look to attract our audience? Then a moodboard: images that capture the essence of your brand.",
      questions: [
        { key: "look", type: "long", label: "How the brand should look", hint: "For example: bold, high-end, techy." },
        {
          key: "feel",
          type: "long",
          label: "How people should feel when dealing with the brand",
          hint: "For example: confident, proud, empowered.",
        },
        {
          key: "moodboard",
          type: "images",
          min: 1,
          max: 12,
          label: "Moodboard",
          hint: "Upload images and elements that capture the essence of your brand: colours, type, places, people, products, anything that feels like you.",
        },
      ],
    },
  ],
};

export const BRIEF_FORMS: BriefForm[] = [BRAND_WORKSHOP];
export const briefFormByKey = (key: string) => BRIEF_FORMS.find((f) => f.key === key) ?? null;

// ------------------------------------------------------------- answers --
const filled = (v: unknown) => typeof v === "string" && v.trim().length > 0;

/** Same rules as public._brief_answered in the database. */
export function answered(q: BriefQuestion, a: unknown): boolean {
  switch (q.type) {
    case "text":
    case "long":
      return filled(a);
    case "scale": {
      const o = (a ?? {}) as Record<string, unknown>;
      return q.pairs.every((p) => /^[1-7]$/.test(String(o[p.key] ?? "")));
    }
    case "fields": {
      const o = (a ?? {}) as Record<string, unknown>;
      return q.fields.every((f) => filled(o[f.key]));
    }
    case "repeat": {
      const arr = Array.isArray(a) ? (a as Record<string, unknown>[]) : [];
      return arr.length >= q.count && arr.slice(0, q.count).every((it) => q.fields.every((f) => filled(it?.[f.key])));
    }
    case "images":
      return Array.isArray(a) && a.length >= q.min;
  }
}

export const allQuestions = (form: BriefForm) => form.sections.flatMap((s) => s.questions);

export function sectionDone(s: BriefSection, answers: BriefAnswers) {
  return s.questions.every((q) => answered(q, answers[q.key]));
}

/** 0 to 100: share of questions answered (a scale or group counts as one). */
export function briefProgress(form: BriefForm, answers: BriefAnswers) {
  const qs = allQuestions(form);
  if (!qs.length) return 0;
  return Math.round((qs.filter((q) => answered(q, answers[q.key])).length / qs.length) * 100);
}

/** "The only X that Y for Z in W in an era of V." from the promise parts. */
export function promiseSentence(a: unknown): string {
  const o = (a ?? {}) as Record<string, unknown>;
  const part = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  // People often retype the lead-in ("The only ..."): don't say it twice.
  const strip = (lead: string, v: string) => v.replace(new RegExp(`^${lead}\\s+`, "i"), "");
  const bits: [string, string][] = [
    ["The only", strip("the only", part("only"))],
    ["that", strip("that", part("that"))],
    ["for", strip("for", part("for"))],
    ["in", strip("in", part("in"))],
    ["in an era of", strip("in an era of", part("era"))],
  ];
  const s = bits
    .filter(([, v]) => v)
    .map(([lead, v]) => `${lead} ${v.replace(/[.\s]+$/, "")}`)
    .join(" ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) + "." : "";
}

/** Everything as plain text (for "Copy answers"). */
export function answersAsText(form: BriefForm, answers: BriefAnswers, header?: string): string {
  const out: string[] = [];
  if (header) out.push(header, "");
  form.sections.forEach((s, si) => {
    out.push(`${String(si + 1).padStart(2, "0")}  ${s.title.toUpperCase()}`, "");
    for (const q of s.questions) {
      const a = answers[q.key];
      switch (q.type) {
        case "text":
        case "long":
          out.push(`${q.label}:`, filled(a) ? String(a).trim() : "(no answer)", "");
          break;
        case "scale": {
          out.push(`${q.label}:`);
          const o = (a ?? {}) as Record<string, unknown>;
          for (const p of q.pairs) {
            const v = Number(o[p.key]);
            const dots = [1, 2, 3, 4, 5, 6, 7].map((i) => (i === v ? "●" : "·")).join(" ");
            out.push(`  ${p.left}  ${dots}  ${p.right}`);
          }
          out.push("");
          break;
        }
        case "fields": {
          const o = (a ?? {}) as Record<string, unknown>;
          out.push(`${q.label}:`);
          for (const f of q.fields) out.push(`  ${f.label}: ${filled(o[f.key]) ? String(o[f.key]).trim() : "-"}`);
          if (q.kind === "promise" && promiseSentence(a)) out.push(`  = ${promiseSentence(a)}`);
          out.push("");
          break;
        }
        case "repeat": {
          const arr = Array.isArray(a) ? (a as Record<string, unknown>[]) : [];
          for (let i = 0; i < q.count; i++) {
            out.push(`${q.item} ${i + 1}:`);
            for (const f of q.fields) out.push(`  ${f.label}: ${filled(arr[i]?.[f.key]) ? String(arr[i]?.[f.key]).trim() : "-"}`);
          }
          out.push("");
          break;
        }
        case "images":
          out.push(`${q.label}: ${Array.isArray(a) ? a.length : 0} image(s), see the Briefs page`, "");
          break;
      }
    }
  });
  return out.join("\n").trim();
}
