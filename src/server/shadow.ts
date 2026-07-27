import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Shadow workspace: a temp-directory mirror of the workspace's .compact files
 * so the compiler sees unsaved editor buffers and relative imports resolve
 * exactly as they do on disk.
 */

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "managed", "builds", ".next", "coverage", ".turbo", ".yarn"]);

export class ShadowWorkspace {
  readonly root: string;
  private readonly workspaceRoot: string;
  /** real absolute path -> content hash last written */
  private readonly written = new Map<string, string>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    const key = crypto.createHash("sha1").update(workspaceRoot).digest("hex").slice(0, 12);
    this.root = path.join(os.tmpdir(), "nite-compact-lsp", key);
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** List all .compact files in the workspace (skipping build dirs). */
  listWorkspaceFiles(): string[] {
    const results: string[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".compact")) {
          results.push(full);
        }
      }
    };
    walk(this.workspaceRoot);
    return results;
  }

  toShadowPath(realPath: string): string {
    const rel = path.relative(this.workspaceRoot, realPath);
    if (rel.startsWith("..")) {
      // Outside the workspace: place under a stable escape hatch.
      const hash = crypto.createHash("sha1").update(realPath).digest("hex").slice(0, 8);
      return path.join(this.root, "__external__", hash, path.basename(realPath));
    }
    return path.join(this.root, rel);
  }

  toRealPath(shadowPath: string): string | null {
    const rel = path.relative(this.root, shadowPath);
    if (rel.startsWith("..") || rel.startsWith("__external__")) return null;
    return path.join(this.workspaceRoot, rel);
  }

  /**
   * Sync the mirror. `overlays` maps real absolute paths to in-editor
   * (possibly unsaved) content which takes precedence over disk.
   * Returns the set of real files mirrored.
   */
  sync(overlays: Map<string, string>): Set<string> {
    const files = new Set<string>(this.listWorkspaceFiles());
    for (const overlaid of overlays.keys()) files.add(overlaid);

    for (const realPath of files) {
      let content: string;
      const overlay = overlays.get(realPath);
      if (overlay !== undefined) {
        content = overlay;
      } else {
        try {
          content = fs.readFileSync(realPath, "utf8");
        } catch {
          continue;
        }
      }
      const hash = crypto.createHash("sha1").update(content).digest("hex");
      if (this.written.get(realPath) === hash) continue;
      const shadowPath = this.toShadowPath(realPath);
      fs.mkdirSync(path.dirname(shadowPath), { recursive: true });
      fs.writeFileSync(shadowPath, content, "utf8");
      this.written.set(realPath, hash);
    }
    return files;
  }

  /** Per-compile output directory (kept inside the shadow root, git-invisible). */
  outputDirFor(entryRealPath: string): string {
    const hash = crypto.createHash("sha1").update(entryRealPath).digest("hex").slice(0, 8);
    return path.join(this.root, "__out__", hash);
  }
}
