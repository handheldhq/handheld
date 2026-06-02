import { afterEach, describe, expect, it } from "vitest";
import { CORE_MCP_TOOL_NAMES, listVisibleTools } from "./server.js";

describe("MCP tool list", () => {
  const originalFull = process.env.HANDHELD_MCP_FULL;

  afterEach(() => {
    if (originalFull === undefined) {
      delete process.env.HANDHELD_MCP_FULL;
    } else {
      process.env.HANDHELD_MCP_FULL = originalFull;
    }
  });

  it("exposes the documented core tools by default, including teach_request", () => {
    delete process.env.HANDHELD_MCP_FULL;

    const tools = listVisibleTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([...CORE_MCP_TOOL_NAMES]);
    expect(names).toContain("teach_request");
    expect(names).toContain("capture_evidence");
    expect(names).toContain("list_domain_skills");
    expect(names).toContain("read_domain_skill");
    expect(names).toContain("save_domain_skill_candidate");
    expect(names).toContain("promote_domain_skill");
    expect(names).not.toContain("click");
    expect(names).not.toContain("profile_delete");
    expect(tools.every((tool) => tool._meta?.["handheld/category"] === "core")).toBe(true);
  });

  it("annotates read-only, mutating, destructive, and compatibility tools", () => {
    process.env.HANDHELD_MCP_FULL = "1";

    const byName = new Map(listVisibleTools().map((tool) => [tool.name, tool]));

    expect(byName.get("snap")?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    });
    expect(byName.get("capture_evidence")?.annotations).toMatchObject({
      destructiveHint: false,
      readOnlyHint: false,
    });
    expect(byName.get("list_domain_skills")?.annotations).toMatchObject({
      destructiveHint: false,
      readOnlyHint: true,
    });
    expect(byName.get("save_domain_skill_candidate")?.annotations).toMatchObject({
      destructiveHint: false,
      readOnlyHint: false,
    });
    expect(byName.get("tap")?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: false,
      readOnlyHint: false,
    });
    expect(byName.get("shell")?.annotations).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });
    expect(byName.get("click")?._meta?.["handheld/category"]).toBe("compatibility");
    expect(byName.get("profile_delete")?._meta?.["handheld/category"]).toBe("operator");
  });
});
