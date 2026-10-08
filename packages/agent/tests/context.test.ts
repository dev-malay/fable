import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContext, formatContext } from "../src/context.js";
import { loadSkills } from "../src/skills.js";
import { initContext } from "../src/init.js";

async function sandbox(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fable-ctx-"));
}

describe("FABLE.md discovery", () => {
  test("finds nothing in an empty repo", async () => {
    const dir = await sandbox();
    try {
      expect(await loadContext(dir)).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads a project FABLE.md", async () => {
    const dir = await sandbox();
    try {
      await writeFile(join(dir, "FABLE.md"), "use bun, not npm");
      const found = await loadContext(dir);
      expect(found).toHaveLength(1);
      expect(found[0]?.source).toBe("project");
      expect(found[0]?.body).toContain("use bun");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("walks up to a parent FABLE.md", async () => {
    const dir = await sandbox();
    try {
      await writeFile(join(dir, "FABLE.md"), "root rules");
      const nested = join(dir, "packages", "app");
      await mkdir(nested, { recursive: true });
      const found = await loadContext(nested);
      expect(found.some((e) => e.source === "parent" || e.source === "project")).toBe(true);
      expect(found.some((e) => e.body.includes("root rules"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("strips frontmatter and keeps the body", async () => {
    const dir = await sandbox();
    try {
      await writeFile(join(dir, "FABLE.md"), "---\npaths: [src/**]\n---\nbody text here");
      const found = await loadContext(dir);
      const body = found[0]?.body ?? "";
      expect(body).toContain("body text here");
      expect(body).not.toContain("paths:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("expands @includes", async () => {
    const dir = await sandbox();
    try {
      await writeFile(join(dir, "rules.md"), "always run lint");
      await writeFile(join(dir, "FABLE.md"), "main\n\n@rules.md");
      const found = await loadContext(dir);
      expect(found[0]?.body).toContain("always run lint");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("records a missing include instead of throwing", async () => {
    const dir = await sandbox();
    try {
      await writeFile(join(dir, "FABLE.md"), "@nope.md");
      const found = await loadContext(dir);
      expect(found[0]?.body).toContain("missing include");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("formatContext", () => {
  test("returns empty string when there is no context", () => {
    expect(formatContext([])).toBe("");
  });

  test("wraps entries in tagged blocks", () => {
    const out = formatContext([
      { path: "/x/FABLE.md", body: "hello", source: "project" },
    ]);
    expect(out).toContain('<project-instructions path="/x/FABLE.md">');
    expect(out).toContain("hello");
  });
});

describe("skills", () => {
  test("returns empty when the directory is missing", async () => {
    const dir = await sandbox();
    try {
      expect(await loadSkills(dir)).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reads name and description from frontmatter", async () => {
    const dir = await sandbox();
    try {
      await mkdir(join(dir, ".fable", "skills"), { recursive: true });
      await writeFile(
        join(dir, ".fable", "skills", "deploy.md"),
        "---\nname: deploy\ndescription: ship it\n---\nrun the ship script",
      );
      const skills = await loadSkills(dir);
      expect(skills).toHaveLength(1);
      expect(skills[0]?.name).toBe("deploy");
      expect(skills[0]?.description).toBe("ship it");
      expect(skills[0]?.body).toContain("run the ship script");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the filename when frontmatter has no name", async () => {
    const dir = await sandbox();
    try {
      await mkdir(join(dir, ".fable", "skills"), { recursive: true });
      await writeFile(join(dir, ".fable", "skills", "review.md"), "just a body");
      const skills = await loadSkills(dir);
      expect(skills[0]?.name).toBe("review");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores non-markdown files", async () => {
    const dir = await sandbox();
    try {
      await mkdir(join(dir, ".fable", "skills"), { recursive: true });
      await writeFile(join(dir, ".fable", "skills", "notes.txt"), "ignore me");
      expect(await loadSkills(dir)).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("init", () => {
  test("creates FABLE.md once and never clobbers it", async () => {
    const dir = await sandbox();
    try {
      const first = await initContext(dir);
      expect(first.created).toBe(true);
      const second = await initContext(dir);
      expect(second.created).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});