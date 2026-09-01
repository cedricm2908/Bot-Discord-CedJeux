---
name: Workspace dependency scope
description: A pnpm workspace dependency should be installed in the package that imports it.
---

The package-management helper may default to the monorepo root; for a workspace app, dependency installation must be scoped to the owning package.

**Why:** Root installs trigger pnpm's workspace-root guard and leave the application package without its runtime dependency.

**How to apply:** Use the package filter for the specific workspace package when adding a dependency, then run that package's typecheck and build.