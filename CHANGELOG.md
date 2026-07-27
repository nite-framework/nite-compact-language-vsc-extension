# Changelog

All notable changes to the Nite Compact extension are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
