# Changelog

All notable changes to the Nite Compact extension are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-07-28

Language-intelligence release: the extension now understands ledger types, your
documentation, and your file graph — not just compiler errors.

### Added
- **Ledger ADT member completion.** Typing `field.` offers only the operations valid for that field's declared type (`Counter`, `Set`, `Map`, `List`, `MerkleTree`, `HistoricMerkleTree`, and plain cell fields), with signatures specialized to the declared type arguments — on `Map<Bytes<32>, Account>`, `lookup` reads `lookup(key: Bytes<32>): Account`. An unresolvable receiver offers nothing rather than a misleading global list.
- **Cross-file resolution through import prefixes**, so `Store_balances.` resolves to the declaration inside the imported module.
- **Hover** for ledger fields (declared type, ADT summary, available operations), ADT operations (signature, semantics, where they are valid), parameters, constants, and declarations reached through an import prefix — the latter noting the file they come from.
- **Go to definition** (`definitionProvider`) for local and prefixed-imported declarations, landing on the exact line and name.
- **Doc comments.** A `/** … */` block or a run of `//` lines directly above a declaration becomes its documentation in hover and completion, including across import boundaries. A blank line detaches the comment, so it is not misattributed.
- **Import links.** Specifiers in `import "./modules/Store"` / `include "…"` are ctrl-clickable (`documentLinkProvider`), navigable with F12, and hovering one shows the resolved path plus the declarations it exports under their prefixed names. Bare library imports such as `import CompactStandardLibrary;` are correctly excluded.
- **Missing-pragma warning.** An entry contract with no `pragma language_version` is flagged as a warning by the extension (`source: "nite-compact"`, distinct from compiler errors). The compiler accepts its absence, so this is a lint, not an error — the file would otherwise build against whatever toolchain happens to be installed. Imported modules are exempt. Toggle with `niteCompact.warnMissingPragma`.

### Fixed
- **Errors inside imported modules were attributed to the wrong file.** The compiler names such files by bare basename (`Store.compact`, never `modules/Store.compact`); the path mapper guessed "next to the root" and, on a miss, blamed the root contract. It now resolves basenames against the files already mirrored for the check, preferring those reachable from the root being compiled.
- **ADT operation hover never appeared.** The receiver was located using the cursor offset rather than the word's start, so hovering anywhere but the final character silently failed.
- **Declarations reached through an import prefix had no hover at all** — only local symbols were searched.
- `Cell` removed from the ledger type list: it is not a real type, and the compiler reports "unbound identifier Cell". A plain typed field is the cell.
- `.compact` file icons resized from 2369px (~72 KB each) to a padded 128×128 square (~3 KB), so they render crisply in the file tree instead of being downscaled from a 2000-pixel-wide source.
- File icons are now packaged at all: `.vscodeignore` still whitelisted the previous `.svg` filenames, so the replacement `.png` icons were being excluded from the VSIX entirely.

### Notes
- Every ADT operation, arity, argument type, and return type was verified against the real compiler (toolchain 0.5.1 / compiler 0.31.1) by probing it, not by reading prose. The published documentation was found to disagree with the compiler — it lists `contains` for `Set`/`Map` where the real operation is `member`, and spells `resetToDefault` in snake case — so it was not used as a source.
- `test/run-pipeline.mjs` re-verifies the entire ADT table against whatever toolchain is installed, so a future compiler that renames an operation fails the suite instead of shipping a stale claim.
- Hover never infers types: an unannotated `const` shows its initializer verbatim, not a guessed type.

## [0.1.1] - 2026-07-27

### Added
- Humanized diagnostics: recognized compiler errors (unbound identifier, argument mismatch, witness disclosure, type mismatches, parse errors) are rewritten in plain English with "How to fix" hints and clickable related locations.

## [0.1.0] - 2026-07-27

### Added
- Live compiler-backed diagnostics via `compact compile --skip-zk` against a shadow workspace, on type (debounced) or on save.
- Multi-file awareness: import-graph root selection re-checks the contracts that import an edited module; unsaved buffers in other tabs are overlaid.
- Completion: keywords, built-in types, ledger ADTs, curated stdlib with signatures/docs, own-file symbols, and prefixed imports.
- Hover for stdlib functions and local declarations.
- Document symbols / outline (modules, circuits, witnesses, ledgers, structs, enums).
- Document formatting via `compact format`.
- TextMate grammar for current Compact syntax, language configuration, and snippets.
- Settings: `compactPath`, `toolchainVersion`, `compileMode`, `debounceMs`, `maxRootsPerCheck`.
- Commands: *Check Current File Now*, *Restart Language Server*.
