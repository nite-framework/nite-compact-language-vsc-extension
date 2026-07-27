# Publishing Guide

How to ship `nite-compact` to the **VS Code Marketplace** (VS Code users) and **Open VSX** (Cursor, VSCodium, Windsurf, Gitpod, Theia users). Publishing to both is recommended — Midnight developers are heavily represented on Cursor.

---

## 1. One-time setup

### 1.1 Create a Marketplace publisher

The `publisher` field in [package.json](../package.json) is `codebigint`. That ID must exist on the Marketplace and belong to you.

1. Go to <https://marketplace.visualstudio.com/manage> and sign in with a Microsoft account.
2. Click **Create publisher**. Set the **ID** to exactly `codebigint` (IDs are permanent; display name can be anything, e.g. "codeBigInt").
3. If `codebigint` is taken, pick another ID and update `"publisher"` in package.json to match.

### 1.2 Create a Personal Access Token (PAT)

`vsce` authenticates against Azure DevOps:

1. Go to <https://dev.azure.com> → sign in with the **same** Microsoft account → click your avatar → **Personal access tokens** → **New Token**.
2. Settings that matter:
   - **Organization**: *All accessible organizations* (required — a single-org token fails with 401).
   - **Scopes**: *Custom defined* → **Marketplace → Manage**.
   - **Expiration**: your choice (max 1 year; you'll rotate it).
3. Copy the token immediately — it is shown once.

Log in locally (stores the PAT in your OS keychain):

```bash
npx @vscode/vsce login codebigint
# paste the PAT when prompted
```

### 1.3 Open VSX account (optional but recommended)

1. Sign in at <https://open-vsx.org> with GitHub.
2. Sign the Eclipse publisher agreement (linked from your profile page).
3. Create an access token: profile → **Access Tokens** → **Generate New Token**.
4. The namespace must match the publisher ID:

```bash
npx ovsx create-namespace codebigint -p <OPEN_VSX_TOKEN>
```

---

## 2. Pre-flight checklist (every release)

- [ ] **Version bumped** in [package.json](../package.json) (semver — the Marketplace rejects re-publishing an existing version).
- [ ] **[CHANGELOG.md](../CHANGELOG.md) updated** — it renders as the *Changelog* tab on your listing.
- [ ] **README is the storefront** — the *Overview* tab is your README verbatim. Check that images use absolute URLs or ship in the vsix (relative image paths only work if the `repository` URL is a real public repo).
- [ ] **`repository.url` is real.** package.json currently points at `github.com/nite-framework/nite-compact-language-vsc-extension`. If the code actually lives elsewhere (e.g. under `codeBigInt`), fix it — the Marketplace links "Repository" and resolves relative README links against it.
- [ ] **Code pushed & tagged**: `git tag v0.1.1 && git push --tags` so a published version is always reproducible.
- [ ] **Tests pass with the real compiler**: `npm test` (needs the `compact` CLI on PATH — the end-to-end section silently skips without it, so make sure it printed `using compactc ...`, not `skip`).
- [ ] **Smoke-test the exact artifact** you are about to publish:

  ```bash
  npm run package                                   # test + bundle + vsce package
  code --install-extension nite-compact-<version>.vsix
  ```

  Open a `.compact` file and verify: squiggles on type, completion, hover, outline, format-document, and both commands in the palette.

- [ ] **Inspect the package contents** — no secrets, no bloat:

  ```bash
  npx @vscode/vsce ls
  ```

  Expected contents: `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, `language-configuration.json`, `syntaxes/`, `snippets/`, `out/extension.js`, `out/server/*.js`, and the three whitelisted assets. Anything else → tighten [.vscodeignore](../.vscodeignore).

> Note: `out/server/` contains both the esbuild bundle (`main.js`) and leftover per-module `tsc` output (`compiler.js`, `shadow.js`, …) that only the tests use. Only `main.js` is loaded at runtime; the rest is a few KB of harmless dead weight. Add `out/server/*.js` exceptions to `.vscodeignore` if you want a minimal vsix — but keep `out/extension.js` and `out/server/main.js`.

---

## 3. Publish

### VS Code Marketplace

```bash
npm run package                # produces nite-compact-<version>.vsix
npx @vscode/vsce publish       # builds & uploads (uses the stored login)
# — or publish the exact vsix you smoke-tested (preferred):
npx @vscode/vsce publish --packagePath nite-compact-<version>.vsix
```

`vsce` can also bump for you: `npx @vscode/vsce publish patch` (or `minor` / `major`) increments package.json, commits nothing, and publishes.

Verification takes a few minutes; the listing appears at:

```
https://marketplace.visualstudio.com/items?itemName=codebigint.nite-compact
```

Check the **Manage** page for validation warnings after the first upload.

### Open VSX

Publish the *same* vsix so both stores carry identical bits:

```bash
npx ovsx publish nite-compact-<version>.vsix -p <OPEN_VSX_TOKEN>
```

---

## 4. Post-publish

- Install from the Marketplace (not the local vsix) on a clean profile: `code --install-extension codebigint.nite-compact`.
- Verify the listing renders: icon, README images, changelog tab.
- Marketplace propagation to the in-editor search can take ~15 minutes.

## 5. Unpublishing / recovering from mistakes

- A bad version can be **unpublished** from the Manage page, but the version number is burned forever — you must bump to republish.
- Prefer publishing a fixed **patch** version over unpublishing; unpublishing breaks users' auto-update chain.

## 6. Optional: automate with GitHub Actions

Tag-driven release publishing to both stores. Add the PAT as repo secret `VSCE_PAT` and the Open VSX token as `OVSX_PAT`:

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run build
      # CI has no compact CLI: bundle + package directly instead of `npm run package`
      - run: npm run bundle
      - run: npx @vscode/vsce package --no-yarn
      - run: npx @vscode/vsce publish --packagePath *.vsix -p ${{ secrets.VSCE_PAT }}
      - run: npx ovsx publish *.vsix -p ${{ secrets.OVSX_PAT }}
```

The `npm test` suite needs the real `compact` CLI, so in CI it is skipped (or install the CLI in a prior step to keep the end-to-end gate).

## 7. Releasing a new version — quick recipe

```bash
# 1. code + changelog
$EDITOR CHANGELOG.md
# 2. bump, test, package, smoke-test
npm version patch --no-git-tag-version
npm run package
code --install-extension nite-compact-*.vsix   # manual check
# 3. commit + tag + publish
git add -A && git commit -m "release: v$(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")" && git push && git push --tags
npx @vscode/vsce publish --packagePath nite-compact-*.vsix
npx ovsx publish nite-compact-*.vsix -p $OVSX_PAT
```
