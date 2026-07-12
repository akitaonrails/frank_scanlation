import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appCss = readFileSync(resolve(here, "../app.css"), "utf8");
const readerCss = readFileSync(
  resolve(here, "../../src-tauri/injected/reader.css"),
  "utf8",
);

describe("mobile CSS guards do not leak into desktop", () => {
  test("app.css applies safe-area rules globally", () => {
    expect(appCss).toContain("html,\nbody");
    expect(appCss).toContain("env(safe-area-inset-top)");
  });

  test("app.css gates touch-target rules under pointer: coarse", () => {
    expect(appCss).toContain("@media (pointer: coarse)");
    expect(appCss).toContain("min-height: 44px");
  });

  test("reader.css gates touch ergonomics under pointer: coarse", () => {
    expect(readerCss).toContain("@media (pointer: coarse)");
    expect(readerCss).toContain("touch-action: manipulation");
  });

  test("44px touch targets only appear inside a mobile/touch guard", () => {
    for (const [name, body] of [
      ["app.css", appCss],
      ["reader.css", readerCss],
    ] as const) {
      const lines = body.split("\n");
      let inGuard = false;
      let guardDepth = 0;
      let depth = 0;
      for (const line of lines) {
        const opens = (line.match(/{/g) || []).length;
        const closes = (line.match(/}/g) || []).length;
        if (line.includes("@media")) {
          inGuard = true;
          guardDepth = depth + opens;
        }
        if (
          line.includes("min-height: 44px") ||
          line.includes("min-width: 44px")
        ) {
          if (!inGuard) {
            throw new Error(
              `${name} has a 44px touch target outside a mobile/touch guard:\n  ${line.trim()}`,
            );
          }
        }
        depth += opens - closes;
        if (inGuard && depth < guardDepth) {
          inGuard = false;
        }
      }
      expect(true).toBe(true);
    }
  });
});
