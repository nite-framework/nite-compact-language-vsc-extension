import { ChildProcess, spawn } from "child_process";

export interface CompileResult {
  /** Combined stdout+stderr from the compiler. */
  output: string;
  /** Process exit code, or null if killed. */
  code: number | null;
  cancelled: boolean;
}

export interface CompileOptions {
  compactPath: string;
  /** Toolchain version pin, e.g. "0.31.1"; empty for default. */
  toolchainVersion: string;
  cwd: string;
  timeoutMs?: number;
}

/** A cancellable handle for an in-flight compile. */
export class CompileHandle {
  private child: ChildProcess | null = null;
  private _cancelled = false;

  get cancelled(): boolean {
    return this._cancelled;
  }

  cancel(): void {
    this._cancelled = true;
    if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGKILL");
    }
  }

  run(entryPath: string, outputDir: string, opts: CompileOptions): Promise<CompileResult> {
    const args = ["compile"];
    if (opts.toolchainVersion) args.push(`+${opts.toolchainVersion}`);
    args.push("--skip-zk", entryPath, outputDir);

    return new Promise<CompileResult>((resolve) => {
      if (this._cancelled) {
        resolve({ output: "", code: null, cancelled: true });
        return;
      }

      let output = "";
      const child = spawn(opts.compactPath, args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;

      const timeout = setTimeout(() => this.cancel(), opts.timeoutMs ?? 60_000);

      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));

      child.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ output: `spawn error: ${err.message}`, code: null, cancelled: this._cancelled });
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ output, code, cancelled: this._cancelled });
      });
    });
  }
}

/** Probe the compact CLI. Returns its version string or null when unusable. */
export async function probeCompactCli(compactPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const child = spawn(compactPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.on("error", () => finish(null));
      child.on("close", (code) => finish(code === 0 ? out.trim() : null));
      setTimeout(() => finish(null), 5_000);
    } catch {
      finish(null);
    }
  });
}
