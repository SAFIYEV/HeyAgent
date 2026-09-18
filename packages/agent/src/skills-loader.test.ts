import assert from "node:assert/strict";
import test from "node:test";
import { resolveSkills, buildSkillsPromptBlock, loadSkills } from "./skills-loader.js";

test("explicit skill selection wins over automatic ranking without duplicates", () => {
  const skills = Array.from({ length: 10 }, (_, n) => ({ name: `skill-${n}`, description: "browser", body: "browser" }));
  const selected = resolveSkills(skills, "browser", ["skill-9", "skill-9"]);
  assert.equal(selected[0].name, "skill-9");
  assert.equal(selected.filter((s) => s.name === "skill-9").length, 1);
  assert.throws(() => resolveSkills(skills, "", ["unknown"]), /Unknown skill/);
  assert.throws(() => resolveSkills(skills, "", skills.map((s) => s.name)), /at most 6/);
});

test("selected installed skill reaches the prompt with its complete instructions", async () => {
  const skills = await loadSkills();
  assert.ok(skills.length);
  const skill = skills.find((s) => s.body.length > 1400) ?? skills[0];
  const block = await buildSkillsPromptBlock("unrelated request", [skill.name]);
  assert.ok(block.includes(skill.body));
  assert.ok(block.includes("explicitly selected by the user"));
});
