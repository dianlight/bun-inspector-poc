/**
 * Source transform for dev-inspector-mcp on Bun.
 *
 * Injects `data-insp-path="file:line:col:tag"` attributes into JSX/TSX files.
 * Transformed copies live in _transformed/src/ — Bun.serve() loads from there.
 *
 * BACKGROUND — why a separate step is needed:
 *   Bun 1.3.x JS bundler plugins (Bun.build) do NOT fire onLoad/onResolve for
 *   native file types (.tsx, .jsx). Only NAPI (C/Zig/Rust) plugins can intercept
 *   them via onBeforeParse. So we pre-transform instead, then let Bun bundle the
 *   already-augmented sources normally.
 *
 * This file is both a library (imported by dev.ts) and a standalone script:
 *   bun run scripts/pre-transform.ts            # one-shot
 *   bun run scripts/pre-transform.ts --watch    # watch mode
 */

import { transformCode } from "@code-inspector/core";
import { mkdirSync, readdirSync, watchFile } from "fs";
import { dirname, join, relative } from "path";

export const SRC_DIR = join(import.meta.dir, "../src");
export const OUT_DIR = join(import.meta.dir, "../_transformed/src");

export function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (/\.(tsx|jsx|ts|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export async function transformFile(srcPath: string): Promise<string> {
  const source = await Bun.file(srcPath).text();
  const rel = relative(SRC_DIR, srcPath);
  const outPath = join(OUT_DIR, rel);
  mkdirSync(dirname(outPath), { recursive: true });

  try {
    // transformCode returns a Promise in @code-inspector/core >=1.4.x
    const transformed = await transformCode({
      content: source,
      filePath: srcPath,
      fileType: "jsx", // used for both jsx and tsx
      escapeTags: [],
      pathType: "absolute",
    });
    await Bun.write(outPath, transformed);
    const attrs = (transformed.match(/data-insp-path/g) || []).length;
    console.log(`[transform] ${rel} → ${attrs} attr${attrs !== 1 ? "s" : ""}`);
  } catch (err) {
    console.warn(`[transform] skip ${rel} (transform failed):`, err);
    await Bun.write(outPath, source);
  }
  return outPath;
}

export async function transformAll(): Promise<string[]> {
  mkdirSync(OUT_DIR, { recursive: true });
  const files = collectFiles(SRC_DIR);
  console.log(`[transform] ${files.length} files → ${OUT_DIR}`);
  await Promise.all(files.map(transformFile));
  return files;
}

export function watchTransforms(files: string[]): void {
  for (const f of files) {
    watchFile(f, { interval: 400 }, () => {
      transformFile(f).catch(() => {});
    });
  }
}

// CLI entry — only runs when this file is executed directly
if (import.meta.main) {
  const WATCH = process.argv.includes("--watch");
  const files = await transformAll();

  if (WATCH) {
    console.log("[transform] watching — Ctrl+C to stop");
    watchTransforms(files);
    await new Promise(() => {}); // keep alive
  }
}
