/**
 * Language-version pragma detection.
 *
 * The compiler ACCEPTS a contract with no `pragma language_version` — verified
 * by compiling one: it exits 0 and reports nothing. So a missing pragma cannot
 * be surfaced as a compiler error; the extension raises it as its own warning
 * instead, because without a pragma the file is built against whatever
 * toolchain happens to be installed.
 *
 * Only entry contracts are linted. Imported modules legitimately omit the
 * pragma — every module in real projects does.
 */

/** True when the source declares a language version. */
export function hasLanguagePragma(source: string): boolean {
  return /^[ \t]*pragma\s+language_version\b/m.test(source);
}
