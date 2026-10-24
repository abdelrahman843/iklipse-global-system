// Skills (skills.ts): caveman in the repo, always there; one added from a
// .md file sent on WhatsApp (with or without front matter), listed, replaced,
// removed; the repo's own can't be replaced or removed from WhatsApp.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSkill, addedPlugin, listSkills, pluginsFor, removeSkill, SkillError } from "../src/skills.js";

const state = () => mkdtempSync(join(tmpdir(), "brain-skills-"));

test("caveman is in the repo, and every run loads both plugins", () => {
  const dir = state();
  const s = listSkills(dir);
  const caveman = s.find((x) => x.name === "caveman");
  assert.equal(caveman?.from, "repo");
  assert.match(caveman!.description, /always on/i);
  const plugins = pluginsFor(dir);
  assert.equal(plugins.length, 2);
  assert.ok(existsSync(join(plugins[0]!.path, ".claude-plugin", "plugin.json")));
  assert.ok(existsSync(join(addedPlugin(dir), ".claude-plugin", "plugin.json")));
});

test("a .md file becomes a skill: front matter kept, or made from its name and first line", () => {
  const dir = state();
  const a = addSkill(dir, { content: "---\nname: brief-writer\ndescription: Writes creative briefs.\n---\n\n# Briefs\nAsk for the goal first." });
  assert.equal(a.name, "brief-writer");
  const b = addSkill(dir, { name: "Meeting Notes", content: "# Sum up a meeting in five lines\nNames, dates, decisions." });
  assert.equal(b.name, "meeting-notes");
  assert.equal(b.description, "Sum up a meeting in five lines");
  const text = readFileSync(join(addedPlugin(dir), "skills", "meeting-notes", "SKILL.md"), "utf8");
  assert.match(text, /^---\nname: meeting-notes\ndescription: "Sum up a meeting in five lines"\n---/);
  assert.deepEqual(
    listSkills(dir).filter((x) => x.from === "added").map((x) => x.name),
    ["brief-writer", "meeting-notes"],
  );
  // Sent again: replaced.
  addSkill(dir, { content: "---\nname: brief-writer\ndescription: Shorter briefs.\n---\nOne page." });
  assert.equal(listSkills(dir).find((x) => x.name === "brief-writer")!.description, "Shorter briefs.");
  removeSkill(dir, "meeting-notes");
  assert.ok(!listSkills(dir).some((x) => x.name === "meeting-notes"));
});

test("refused: no name, empty, too long, or one of the repo's", () => {
  const dir = state();
  assert.throws(() => addSkill(dir, { content: "# x" }), SkillError);
  assert.throws(() => addSkill(dir, { name: "ok-name", content: "   " }), SkillError);
  assert.throws(() => addSkill(dir, { name: "big", content: "x".repeat(70_000) }), SkillError);
  assert.throws(() => addSkill(dir, { content: "---\nname: caveman\ndescription: louder\n---\nSHOUT." }), /repo's skills/);
  assert.throws(() => removeSkill(dir, "caveman"), /repo's skills/);
  assert.throws(() => removeSkill(dir, "../../etc"), SkillError);
});
