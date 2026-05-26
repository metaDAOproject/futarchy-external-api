# GitHub protection for `master`

## What the package-protection check does

**Merge-blocking:**
- **Lockfile drift** — `bun.lock` must match `package.json`.
- **Socket package scan** — runs through Bun's security scanner on every install.
- **Exact dependency pinning** — package manifests must use exact versions or `workspace:*`.
- **Minimum dependency age** — newly introduced external npm packages must be at least 14 days old.
- **Phantom deps** — imported packages must be declared in `package.json`.

**Review hint:**
- **Sensitive wallet / program diff** — warns on Solana address literals, program IDs, wallet-routing identifiers, signing paths, and `new PublicKey(` changes. CODEOWNERS is the merge gate for sensitive paths.

## Recommended branch protection for `master`

1. Require a pull request before merging.
2. Require at least 1 approval.
3. Dismiss stale approvals when new commits are pushed.
4. Require conversation resolution before merging.
5. Require status checks to pass before merging.
6. Require the `package-protection` job from the `Package Protection` workflow.
7. Require code owner review so `.github/CODEOWNERS` gates sensitive API, Solana, and operational-script paths.

## Emergency bypass

- Label: `emergency-override` downgrades repo-guard and phantom-dep failures to warnings.
- Lockfile drift / install failures are never bypassed.
