# Nite Compact — Compact Language Server for VS Code

Rust-analyzer-style tooling for the [Midnight](https://midnight.network) Compact smart contract language. Instead of waiting for a full build to find out your contract is broken, errors are underlined **as you type**: every keystroke (debounced) runs a real `compact compile --skip-zk` check against a shadow copy of your workspace, so when the squiggles are gone you know the real compile — ZK artifacts and all — will succeed.

## Features

- **Live compiler-backed diagnostics** — the actual Compact compiler checks your code on type (or on save), with `--skip-zk` for speed. Errors appear at the exact line/column, underlining the offending identifier.
- **Multi-file aware** — editing a module (e.g. `modules/Utils.compact`) automatically re-checks the root contracts that import it. Unsaved buffers in other tabs are seen too.
- **Completion** — keywords, built-in types, ledger ADTs, a curated standard-library set with signatures, your own circuits/ledgers/structs, and prefixed imports (`import "./Utils" prefix Utils_;` → `Utils_…` suggestions).
- **Hover** — signatures and docs for stdlib functions and your own declarations.
- **Outline / document symbols** — modules, circuits, witnesses, ledgers, structs, enums.
- **Formatting** — wired to `compact format`.
- **Modern grammar & snippets** — covers current Compact (`witness`, `sealed`, `struct`, `pure`, `prefix`, `disclose`, `Uint<n>` …), unlike the legacy syntax extension.

## Requirements

- The `compact` CLI (Compact developer tools) on your `PATH` with at least one compiler toolchain installed:

  ```bash
  curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
  compact update
  ```

- VS Code 1.85+ (or any editor speaking LSP; the server is editor-agnostic).

If `compact` lives elsewhere, set `niteCompact.compactPath`.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `niteCompact.compactPath` | `compact` | Path to the compact CLI. |
| `niteCompact.toolchainVersion` | `""` | Pin a compiler version (passed as `+VERSION`). Empty = default toolchain. |
| `niteCompact.compileMode` | `onType` | `onType` (debounced live checking) or `onSave`. |
| `niteCompact.debounceMs` | `400` | Delay after the last keystroke before compiling. |
| `niteCompact.maxRootsPerCheck` | `4` | Max root contracts recompiled when a shared module changes. |

## Commands

- **Nite Compact: Check Current File Now** — force an immediate check.
- **Nite Compact: Restart Language Server**

## How it works

1. On edit, the server mirrors your workspace's `.compact` files into a temp *shadow workspace*, overlaying unsaved editor buffers, so relative imports resolve exactly as on disk.
2. It builds an import graph from `import "..."`/`include "..."` statements and picks the root contract(s) affected by your change.
3. It runs `compact compile --skip-zk <root> <tmp-out>` (killing any superseded in-flight compile) and parses the compiler's `file line N char M` error output into precise editor diagnostics, mapped back to your real files.

`--skip-zk` skips proving-key generation — the slow part — so checks complete in a few hundred milliseconds on typical contracts.

## Developing

```bash
npm install
npm run build
npm test        # runs the pipeline against the real compact CLI, no VSCode needed
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded. To install it into your editor for daily use:

```bash
npm run package             # produces nite-compact-<version>.vsix
code --install-extension nite-compact-0.1.0.vsix
```

> Tip: disable the legacy `midnightnetwork.compact` extension while this one is enabled — both register the `compact` language and their grammars will compete.

## Roadmap

- Go-to-definition across modules (the import graph and symbol index already exist).
- Workspace symbols and rename.
- Tree-sitter grammar for instant syntax errors without spawning the compiler.
- Open VSX publication for Cursor/VSCodium/Windsurf.
# nite-compact-language-vsc-extension
