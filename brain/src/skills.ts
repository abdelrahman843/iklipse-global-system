// Skills: what the brain knows how to do, as Claude Code skills (SKILL.md),
// loaded into every run as two local plugins:
// - "iklipse": the ones in the repo (brain/plugin/skills), caveman among
//   them, changed only by a PR like the rest of the code;
// - "added": the ones the owner or an admin sends on WhatsApp as a .md file
//   (skill_add), kept on this server (stateDir/skills-plugin), changed or
//   removed the same way. They're instructions, never secrets: any run can
//   read them.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillInfo {
  name: string;
  description: string;
  /** In the repo (bundled), or added on WhatsApp. */
  from: "repo" | "added";
}

/** The repo's own skills (a plugin next to the code). */
export const bundledPlugin = () => fileURLToPath(new URL("../plugin", import.meta.url));
/** The skills added on WhatsApp. */
export const addedPlugin = (stateDir: string) => join(stateDir, "skills-plugin");

const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
/** A skill file, at most. */
export const MAX_SKILL = 60_000;

/** The added skills' plugin, made once (its manifest), so Claude Code loads it even when it's empty. */
export function ensureAdded(stateDir: string) {
  const dir = addedPlugin(stateDir);
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  const manifest = join(dir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ name: "added", description: "Skills the team added on WhatsApp.", version: "1.0.0" }, null, 2));
  return dir;
}

/** The plugins a run loads (run.ts). */
export const pluginsFor = (stateDir: string) => [
  { type: "local" as const, path: bundledPlugin() },
  { type: "local" as const, path: ensureAdded(stateDir) },
];

/** name and description from a SKILL.md's front matter. */
export function frontMatter(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { body: text };
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(m[1]!)?.[1]?.trim().replace(/^["']|["']$/g, "");
  return { name: field("name"), description: field("description"), body: text.slice(m[0].length) };
}

function read(dir: string, from: SkillInfo["from"]): SkillInfo[] {
  const skills = join(dir, "skills");
  if (!existsSync(skills)) return [];
  return readdirSync(skills, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(skills, d.name, "SKILL.md")))
    .map((d) => {
      const f = frontMatter(readFileSync(join(skills, d.name, "SKILL.md"), "utf8"));
      return { name: d.name, description: f.description ?? "", from };
    });
}

export function listSkills(stateDir: string): SkillInfo[] {
  return [...read(bundledPlugin(), "repo"), ...read(ensureAdded(stateDir), "added")].sort((a, b) => a.name.localeCompare(b.name));
}

export class SkillError extends Error {}

/**
 * Adds (or replaces) a skill from a .md file's text: its name from the front
 * matter, else the one given; a file without front matter gets one (its
 * description: the one given, else its first line). One in the repo can't be
 * replaced from WhatsApp.
 */
export function addSkill(stateDir: string, x: { name?: string; content: string; description?: string }): SkillInfo {
  const content = x.content.replace(/\r\n/g, "\n").trim();
  if (!content) throw new SkillError("The skill is empty: send the .md file with it.");
  if (content.length > MAX_SKILL) throw new SkillError(`The skill is too long (${content.length} characters, ${MAX_SKILL} at most).`);
  const f = frontMatter(content);
  const name = (f.name ?? x.name ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!NAME.test(name)) throw new SkillError("The skill needs a name: lower case letters, numbers and dashes (2 to 40).");
  if (read(bundledPlugin(), "repo").some((s) => s.name === name)) throw new SkillError(`${name} is one of the repo's skills: change it with a PR.`);
  const description = (f.description ?? x.description ?? f.body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? name).trim().slice(0, 500);
  const text = f.name && f.description ? content : `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${f.body.trim()}\n`;
  const dir = join(ensureAdded(stateDir), "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
  return { name, description, from: "added" };
}

export function removeSkill(stateDir: string, name: string) {
  const n = name.trim().toLowerCase();
  if (!NAME.test(n)) throw new SkillError("Which skill (its name)?");
  if (read(bundledPlugin(), "repo").some((s) => s.name === n)) throw new SkillError(`${n} is one of the repo's skills: it's removed with a PR.`);
  const dir = join(ensureAdded(stateDir), "skills", n);
  if (!existsSync(dir)) throw new SkillError(`There's no added skill ${n}.`);
  rmSync(dir, { recursive: true, force: true });
}
