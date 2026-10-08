import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionEngine } from "../src/permissions.js";
import { resolveInCwd, cap, int, str } from "../src/tools/types.js";
import { globToRegExp } from "../src/tools/files.js";

describe("PermissionEngine defaults", () => {
  let engine: PermissionEngine;
  beforeEach(() => {
    engine = new PermissionEngine();
  });

  test("read-only tools are auto-allowed", () => {
    for (const tool of ["Read", "Glob", "Grep", "WebFetch", "TodoWrite"]) {
      expect(engine.evaluate(tool, {})).toBe("allow");
    }
  });

  test("write tools ask by default", () => {
    expect(engine.evaluate("Write", { path: "a.ts" })).toBe("ask");
    expect(engine.evaluate("Edit", { path: "a.ts" })).toBe("ask");
  });

  test("safe bash is allowed", () => {
    expect(engine.evaluate("Bash", { command: "ls -la" })).toBe("allow");
    expect(engine.evaluate("Bash", { command: "git status" })).toBe("allow");
    expect(engine.evaluate("Bash", { command: "cat package.json" })).toBe("allow");
  });

  test("destructive bash is denied outright", () => {
    expect(engine.evaluate("Bash", { command: "rm -rf dist" })).toBe("deny");
    expect(engine.evaluate("Bash", { command: "sudo rm x" })).toBe("deny");
    expect(engine.evaluate("Bash", { command: "chmod 777 x" })).toBe("deny");
  });

  test("unknown bash asks", () => {
    expect(engine.evaluate("Bash", { command: "deploy-prod --now" })).toBe("ask");
  });

  test("an unknown tool falls back to ask, never allow", () => {
    expect(engine.evaluate("SomethingElse", {})).toBe("ask");
  });
});

describe("permission modes", () => {
  test("acceptEdits allows writes but keeps bash gated", () => {
    const engine = new PermissionEngine("acceptEdits");
    expect(engine.evaluate("Write", { path: "a.ts" })).toBe("allow");
    expect(engine.evaluate("Edit", { path: "a.ts" })).toBe("allow");
    expect(engine.evaluate("Bash", { command: "deploy-prod" })).toBe("ask");
  });

  test("plan denies every write and shell command", () => {
    const engine = new PermissionEngine("plan");
    expect(engine.evaluate("Write", { path: "a.ts" })).toBe("deny");
    expect(engine.evaluate("Edit", { path: "a.ts" })).toBe("deny");
    expect(engine.evaluate("Bash", { command: "ls" })).toBe("deny");
  });

  test("bypass allows reads too", () => {
    const engine = new PermissionEngine("bypass");
    expect(engine.evaluate("Read", { path: "a.ts" })).toBe("allow");
    expect(engine.evaluate("Bash", { command: "rm -rf /" })).toBe("allow");
  });

  test("getMode reflects the active mode", () => {
    expect(new PermissionEngine("plan").getMode()).toBe("plan");
  });
});

describe("tool input helpers", () => {
  test("str returns undefined for optional misses", () => {
    expect(str({}, "missing", false)).toBeUndefined();
  });

  test("str throws for required misses", () => {
    expect(() => str({}, "missing")).toThrow(/missing required input/);
  });

  test("str rejects non-strings", () => {
    expect(() => str({ a: 1 }, "a")).toThrow(/must be a string/);
  });

  test("int falls back and validates", () => {
    expect(int({}, "n", 7)).toBe(7);
    expect(() => int({ n: 1.5 }, "n", 1)).toThrow(/integer/);
  });

  test("cap truncates and marks the cut", () => {
    const out = cap("x".repeat(100), 10);
    expect(out.startsWith("xxxxxxxxxx")).toBe(true);
    expect(out).toContain("truncated 90 chars");
  });

  test("cap leaves short text alone", () => {
    expect(cap("short", 10)).toBe("short");
  });
});

describe("path jailing", () => {
  test("allows paths inside cwd", () => {
    const cwd = tmpdir();
    expect(() => resolveInCwd(cwd, "src/index.ts")).not.toThrow();
  });

  test("blocks parent traversal", () => {
    const cwd = join(tmpdir(), "proj");
    expect(() => resolveInCwd(cwd, "../../etc/passwd")).toThrow(/escapes working directory/);
  });
});

describe("glob translation", () => {
  test("single star does not cross separators", () => {
    const rx = globToRegExp("src/*.ts");
    expect(rx.test("src/a.ts")).toBe(true);
    expect(rx.test("src/nested/a.ts")).toBe(false);
  });

  test("double star crosses separators", () => {
    const rx = globToRegExp("src/**/*.ts");
    expect(rx.test("src/nested/deep/a.ts")).toBe(true);
  });

  test("escapes regex metacharacters", () => {
    const rx = globToRegExp("a.b.txt");
    expect(rx.test("a.b.txt")).toBe(true);
    expect(rx.test("axbxtxt")).toBe(false);
  });
});

describe("persistence", () => {
  test("user rules survive a reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fable-perm-"));
    try {
      const engine = new PermissionEngine();
      await engine.addRule({ tool: "Write", decision: "allow" });
      const reloaded = new PermissionEngine();
      await reloaded.load();
      expect(reloaded.evaluate("Write", { path: "a.ts" })).toBe("allow");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});