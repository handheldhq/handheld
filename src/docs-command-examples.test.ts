import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docs = ["README.md", "install.md", "src/commands/guide.ts"];
const forbiddenShellNames = [
  "long_press",
  "double_tap",
  "press_key",
  "list_apps",
  "open_app",
];

describe("documented shell command names", () => {
  it("uses hyphenated CLI names in handheld shell examples", () => {
    for (const doc of docs) {
      const text = readFileSync(resolve(doc), "utf8");
      for (const name of forbiddenShellNames) {
        expect(text, doc + " should not show handheld " + name).not.toMatch(
          new RegExp("handheld\\s+" + name + "\\b")
        );
      }
    }
  });
});
