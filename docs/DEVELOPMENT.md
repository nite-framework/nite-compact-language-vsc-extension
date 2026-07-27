# Developer Documentation

Architecture, internals, and contribution guide for the Nite Compact language extension. Read [README.md](../README.md) first for the user-facing feature list; this document explains *how* it works and how to change it.

---

## 1. Design philosophy

**The compiler is the only source of truth for correctness.** This extension never tries to re-implement Compact's type system, disclosure analysis, or parser. Every diagnostic a user sees comes from a real `compact compile --skip-zk` run. The extension's own static analysis (regex symbol extraction, import scanning) is used only for *assistive* features — completion, outline, hover, choosing what to compile — where being occasionally wrong costs a suggestion, never a false "your code is fine".

Consequences of this stance:

- No false negatives: if the squiggles are gone, the real build (minus ZK key generation) succeeds.
- The hard problems (incremental checking speed, unsaved buffers, multi-file projects) are solved *around* the compiler: shadow workspace, import-graph root selection, debounce + cancellation.
- The assistive layer is deliberately regex-based and cheap ([symbols.ts](../src/server/symbols.ts) is ~130 lines). Replacing it with a tree-sitter grammar is on the roadmap, not a prerequisite.

## 2. Repository layout

```
├── src/
│   ├── extension.ts          # VS Code client: starts/stops the language server
│   └── server/               # Editor-agnostic LSP server (no vscode imports!)
│       ├── main.ts           # LSP wiring: capabilities, handlers, diagnostics pipeline
│       ├── shadow.ts         # Shadow workspace (temp-dir mirror w/ unsaved overlays)
│       ├── imports.ts        # Import graph: scan, resolve, find compile roots
│       ├── compiler.ts       # Spawns `compact compile`, cancellable handle, CLI probe
│       ├── diagnostics.ts    # Parses compiler output; humanizes known messages
│       ├── symbols.ts        # Regex symbol extraction (outline/completion/hover)
│       └── stdlib.ts         # Static completion data: keywords, types, stdlib entries
├── syntaxes/compact.tmLanguage.json   # TextMate grammar (highlighting)
├── language-configuration.json        # Brackets, comments, auto-close pairs
├── snippets/compact.code-snippets     # Snippets
├── test/
│   ├── run-pipeline.mjs      # Integration tests (real compiler, no VS Code)
│   └── fixtures/             # good/bad .compact files + a module
├── assets/                   # Icons (only 3 files ship in the vsix)
├── out/                      # Build output (tsc for tests, esbuild bundles for runtime)
└── docs/                     # This file + PUBLISHING.md
```

**Layering rule:** nothing under `src/server/` may import the `vscode` module. The server speaks pure LSP over stdio/IPC, so it works with any LSP-capable editor (Neovim, Helix, …) — only [extension.ts](../src/extension.ts) is VS Code-specific.

## 3. Process architecture

```
┌─────────────────────────── VS Code (extension host) ───────────────────────────┐
│  extension.ts (client)                                                         │
│    LanguageClient  ── registers commands, forwards config, restarts server     │
└───────────────┬────────────────────────────────────────────────────────────────┘
                │ JSON-RPC over Node IPC (TransportKind.ipc)
┌───────────────▼──────────────── server process ────────────────────────────────┐
│  main.ts                                                                       │
│    documents (TextDocuments)  settings  debounce timers  compileGeneration     │
│    ┌──────────┐   ┌───────────┐   ┌──────────────┐   ┌─────────────────┐       │
│    │ shadow.ts │→ │ imports.ts │→ │ compiler.ts  │→ │ diagnostics.ts   │       │
│    │  mirror   │  │ pick roots │  │ spawn compile│  │ parse + humanize │       │
│    └──────────┘   └───────────┘   └──────┬───────┘   └─────────────────┘       │
└──────────────────────────────────────────┼─────────────────────────────────────┘
                                           │ child process
                              compact compile --skip-zk <entry> <out>
                              (cwd = shadow root, in $TMPDIR/nite-compact-lsp/…)
```

The client ([extension.ts](../src/extension.ts)) is intentionally thin (~55 lines):

- Activates on `workspaceContains:**/*.compact` (see package.json `activationEvents`).
- Starts the server from `out/server/main.js` over IPC; the `debug` variant adds `--inspect=6009` for attaching a debugger.
- `synchronize.configurationSection: "niteCompact"` pushes setting changes to the server.
- Two commands: `niteCompact.restartServer` (client-side `client.restart()`) and `niteCompact.checkFile`, which sends the custom notification `niteCompact/checkFile` with the active document URI ([extension.ts:40-45](../src/extension.ts#L40-L45), handled at [main.ts:281-284](../src/server/main.ts#L281-L284)).

## 4. The diagnostics pipeline (the heart of the extension)

Entry point: `runCheck(doc)` in [main.ts:137-224](../src/server/main.ts#L137-L224). Triggered by `onDidChangeContent` (debounced by `debounceMs`, only in `onType` mode), `onDidSave`, `onDidOpen`, the `checkFile` notification, and configuration changes — all funnel through `scheduleCheck()`, which coalesces per-URI timers.

### 4.1 Concurrency model: generations + cancellation

Two mechanisms prevent stale results:

- **`compileGeneration`** ([main.ts:62](../src/server/main.ts#L62)) — a monotonically increasing counter. `runCheck` captures the value at entry and bails at every `await` boundary if a newer run has started. Stale runs publish *nothing*.
- **`CompileHandle.cancel()`** ([compiler.ts:28-33](../src/server/compiler.ts#L28-L33)) — SIGKILLs the in-flight `compact` child process, so a superseded compile also stops burning CPU. Each compile also has a 60 s watchdog timeout.

This is a *last-writer-wins* design: there is at most one meaningful `runCheck` at a time, and keystrokes during a compile abort it.

### 4.2 Step by step

1. **Overlay collection** — every open `.compact` document's in-memory text is collected, so unsaved edits in *other tabs* are seen ([main.ts:146-149](../src/server/main.ts#L146-L149)).
2. **Shadow sync** — [`ShadowWorkspace.sync()`](../src/server/shadow.ts#L72-L96) mirrors all workspace `.compact` files into `$TMPDIR/nite-compact-lsp/<sha1(workspace)[:12]>/`, with overlays taking precedence over disk. Writes are skipped when the content hash is unchanged, so a steady-state sync is nearly free. Build/dep dirs (`node_modules`, `.git`, `dist`, `out`, `managed`, `builds`, …) are skipped while walking. Files *outside* the workspace get a hashed home under `__external__/` (one-way: `toRealPath` refuses to map them back).
   *Why a shadow at all?* The compiler only reads files from disk, and relative `import "./x"` resolution must behave exactly as it will in the real build — so the mirror preserves the workspace's relative layout and the compile runs with `cwd = shadow.root`.
3. **Import graph** — [`buildImportGraph()`](../src/server/imports.ts#L38-L59) regex-scans every mirrored file for `import "…"` / `include "…"` (bare imports like `import CompactStandardLibrary;` are compiler built-ins and ignored) and builds forward (`imports`) and reverse (`importers`) edges.
4. **Root selection** — [`findCompileRoots()`](../src/server/imports.ts#L69-L95) walks the reverse edges from the changed file up to files nobody imports: those are the *entry contracts* whose compilation actually validates the change. Editing `modules/Math.compact` therefore re-checks `good.compact`, not the module in isolation (modules often don't compile standalone). The edited file sorts first, and the list is capped at `maxRootsPerCheck` so one edit to a widely-shared module can't trigger 20 compiles. Cycles degrade gracefully: a cycle with no external importer compiles the changed file itself.
5. **Diagnostic ownership** — before compiling, the run computes the set of files it "owns": the changed file plus everything reachable from each root ([main.ts:171-177](../src/server/main.ts#L171-L177)). Every owned file gets an entry in `collected` (initially `[]`), and at the end *all* of them are published — which is how **fixed errors get cleared**: publishing an empty array for a file wipes its squiggles. Files this run never compiled keep their existing diagnostics untouched.
6. **Compile** — one `CompileHandle.run()` per root: `compact compile [+VERSION] --skip-zk <shadowEntry> <shadowOut>`. `--skip-zk` skips proving-key generation (the slow part) so checks complete in a few hundred ms. Output dirs live inside the shadow (`__out__/<hash>`), never in the user's workspace.
7. **Toolchain-failure guard** — [`isToolchainFailure()`](../src/server/diagnostics.ts#L70-L75) distinguishes "the CLI itself is broken" (command not found, no default compiler, …) from "your code has errors", and shows a warning toast instead of bogus squiggles.
8. **Parse** — [`parseCompilerOutput()`](../src/server/diagnostics.ts#L32-L67) matches the compiler's `Exception: <file> line N char M:` blocks (both modern and legacy `line N, char M` comma forms), keeping the indented multi-line explanation structure. Location-less exceptions attach to the entry file at 1:1.
9. **Path mapping** — the compiler prints paths relative to its cwd (the shadow root) or bare basenames; [`mapCompilerPathToReal()`](../src/server/main.ts#L227-L246) maps them back to real workspace files, with fallbacks for basenames.
10. **Humanize** — [`explainDiagnostic()`](../src/server/diagnostics.ts#L146-L279) rewrites recognized compiler messages into plain English with a "How to fix" section, and extracts secondary `at line L char C` references into LSP `relatedInformation` (clickable in the Problems panel). Currently recognized: unbound identifier, no-compatible-function (with arity analysis), witness-disclosure, both type-mismatch shapes (with `Uint<a..b>` inferred-range notes and cast hints), and parse errors. Unrecognized messages pass through with the compiler's original structure.
11. **Range precision** — the compiler only gives a start position; [`underlineEnd()`](../src/server/diagnostics.ts#L285-L294) extends the squiggle over the identifier at that position (or a capped non-whitespace token), converting 1-based compiler coordinates to 0-based LSP ranges in `rangeAt()`.

## 5. Assistive features (server-side, no compiler involved)

### Completion ([main.ts:290-352](../src/server/main.ts#L290-L352))

Four sources, merged then de-duplicated by label (first wins):

1. **Keywords / primitive types / ledger ADTs** — static lists in [stdlib.ts](../src/server/stdlib.ts).
2. **Stdlib** — ~50 curated `StdlibEntry` records (name, signature `detail`, markdown docs, deprecation flag). Every signature was verified against compiler 0.31.1 error output — see the file header. Deprecated entries render struck-through via `CompletionItemTag.Deprecated`.
3. **Own-file symbols** — from `extractSymbols()`.
4. **Imported symbols** — for each `import "./X" prefix P_;` ([`extractPrefixedImports()`](../src/server/symbols.ts#L122-L129)), the target file is read (open-buffer text preferred over disk) and its `export`ed symbols are offered with the prefix applied (`P_addCapped`). Trigger characters `_` and `.` make prefixed completion fire naturally.

### Symbols / outline ([main.ts:376-410](../src/server/main.ts#L376-L410))

[`extractSymbols()`](../src/server/symbols.ts#L73-L119) runs line-oriented regexes for `circuit`, `pure circuit`, `witness`, `ledger`, `struct`, `enum`, `module`, `constructor`, tracking brace depth to attribute symbols to their enclosing `module` (one level — Compact doesn't nest modules meaningfully). The outline nests module members under the module node.

Known limitations (accepted trade-offs, see §1): multi-line declaration headers aren't matched, `/* … */` block comments aren't stripped (only `//`), and braces inside string literals confuse depth tracking. The compiler diagnostics remain correct regardless.

### Hover ([main.ts:436-475](../src/server/main.ts#L436-L475))

Word under cursor → first a stdlib lookup (signature + docs), then own-file symbols (signature + kind/container). No cross-file hover yet.

### Formatting ([main.ts:481-514](../src/server/main.ts#L481-L514))

Writes the buffer to a temp file, runs `compact format <file>` (which formats in place), reads it back, and returns a single whole-document `TextEdit` when the output differs. Failures log and return `[]` — never destroys the buffer.

## 6. Settings flow

Settings are declared in package.json (`contributes.configuration`), typed as `Settings` in [main.ts:35-49](../src/server/main.ts#L35-L49). The client's `synchronize.configurationSection` triggers `onDidChangeConfiguration` on the server, which re-reads config via the pull model (`workspace.getConfiguration`), re-probes the CLI (so fixing `compactPath` recovers without a restart), and re-checks all open docs. Missing/partial config falls back to `DEFAULT_SETTINGS`.

| Setting | Consumed in |
| --- | --- |
| `compactPath` | `probeCompactCli`, `CompileHandle.run`, formatting |
| `toolchainVersion` | passed as `+VERSION` argv to `compact compile` |
| `compileMode` | `onDidChangeContent` gate |
| `debounceMs` | `scheduleCheck` delay |
| `maxRootsPerCheck` | `findCompileRoots` cap |

## 7. Static language assets

- **[syntaxes/compact.tmLanguage.json](../syntaxes/compact.tmLanguage.json)** — TextMate grammar, `scopeName: source.compact`. Pure declarative highlighting; independent of the server (works even with no `compact` CLI).
- **[language-configuration.json](../language-configuration.json)** — comment toggling, bracket pairs, auto-closing.
- **[snippets/compact.code-snippets](../snippets/compact.code-snippets)** — contract/circuit/ledger scaffolds.

When the Compact language gains syntax, update the grammar *and* `KEYWORDS` in stdlib.ts *and* (if declarable) a matcher in symbols.ts.

## 8. Build system

Two compilation paths, on purpose:

| Command | Tool | Output | Used by |
| --- | --- | --- | --- |
| `npm run build` | `tsc` | `out/**` per-module JS + sourcemaps | tests (import individual modules), F5 debugging |
| `npm run bundle` | `esbuild` | `out/extension.js` + `out/server/main.js`, single-file bundles | the shipped vsix |

The bundle step externalizes only `vscode`; `vscode-languageclient/server` etc. are inlined, which is why `dependencies` never need to ship as `node_modules` in the vsix. `npm run package` chains `test → bundle → vsce package`. [.vscodeignore](../.vscodeignore) whitelists: it drops `src/`, `test/`, maps, and all assets except the icon + file icons.

Heads-up: `bundle` overwrites the `tsc`-built `out/extension.js` / `out/server/main.js`. If you F5 after `npm run package`, you're debugging bundles (sourcemaps still work). Run `npm run build` (or the `watch` task) to get back to per-module output.

## 9. Testing

```bash
npm test          # = npm run build && node test/run-pipeline.mjs
```

[test/run-pipeline.mjs](../test/run-pipeline.mjs) is a zero-framework integration suite that imports the compiled server modules directly — **no VS Code instance needed**. Four sections:

1. **Diagnostics parser** — canned compiler outputs: modern + legacy location formats, multi-line structure preservation, underline extension.
2. **explainDiagnostic** — one test per humanized message family, asserting message content *and* related-location extraction; plus the unknown-message fallback.
3. **Symbols + import graph** — extraction from fixtures, prefixed-import parsing, root selection (module edit → root compile), reachability.
4. **End-to-end with the real compiler** — skipped with a notice if `compact` isn't on PATH. Exercises: clean multi-file compile → no diagnostics; broken fixture → located diagnostic at exactly 8:5; **overlay test** (fix the bad file in memory only → diagnostics clear); cancellation resolves promptly.

Section 4 is the regression net for compiler-output format changes: when a new toolchain alters its error text, this section fails first. Fixtures live in [test/fixtures/](../test/fixtures/) — `good.compact` imports `modules/Math.compact` with a `prefix Math_`, `bad.compact` calls `undefinedFunction` at line 8 char 5 (tests hard-code that position; keep it stable).

**Manual testing:** press **F5** ("Run Extension" launch config, which pre-runs the build task) → an Extension Development Host opens → open any folder with `.compact` files. Server-side `console.log` output appears in the host's *Output → Nite Compact Language Server* channel. To step through server code, use the debug server options (`--inspect=6009`) and attach a Node debugger to port 6009.

## 10. How to: common changes

**Add a stdlib completion entry** — append a `StdlibEntry` to `STDLIB` in [stdlib.ts](../src/server/stdlib.ts). Verify the signature against the real compiler first (write a tiny contract that calls it wrongly; the error output prints the declared types). Mark renamed legacy functions with `deprecated: "newName"`.

**Humanize a new compiler error** — add a matcher branch in [`explainDiagnostic()`](../src/server/diagnostics.ts#L146) *before* the fallback. Pattern: match `lines[0]`, harvest structured sub-lines, build a message ending with a `How to fix:` line, populate `related` from `locationRefs()`. Then add a canned-output test in section 1b of the test suite. Unrecognized messages must keep passing through untouched.

**Support a new declaration keyword** (outline/completion) — add a `Matcher` in [symbols.ts](../src/server/symbols.ts) plus kind mappings in `symbolCompletionKind()` / `symbolDocumentKind()` in main.ts, plus the keyword in `KEYWORDS`, plus grammar highlighting.

**Add an LSP capability** (e.g. go-to-definition) — declare it in the `onInitialize` capabilities ([main.ts:71-79](../src/server/main.ts#L71-L79)) and register the handler. For definition specifically, the pieces already exist: `extractPrefixedImports` + `resolveImport` locate the file; `extractSymbols` gives the target line.

**React to a new compiler output format** — extend the regexes in diagnostics.ts (`LOCATED_RE` already accepts two vintages); the real-compiler test section will tell you when this becomes necessary.

## 11. Known limitations & roadmap

- Only the **first workspace folder** is used (multi-root workspaces: other folders are ignored).
- Shadow directories in `$TMPDIR` are never garbage-collected across workspaces (bounded: one dir per workspace path, contents overwritten in place).
- Deleting a `.compact` file leaves its stale mirror in the shadow until the server restarts (the sync only adds/updates).
- Regex symbol extraction misses multi-line declarations and block comments (§5).
- Roadmap (from README): go-to-definition, workspace symbols/rename, tree-sitter grammar for instant syntax errors, Open VSX publication.
