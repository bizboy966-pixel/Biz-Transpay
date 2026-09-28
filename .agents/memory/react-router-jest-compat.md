---
name: React Router tests
description: A Jest 27 resolver limitation encountered with React Router v7 package exports.
---

When Jest 27 fails to resolve React Router v7's internal `react-router/dom` export, avoid importing the full router just to provide a location in a focused component test. Mock the specific router hook the component uses, such as `useLocation`.

**Why:** The frontend's production bundler resolves the package exports, but Jest's resolver can fail before the tested component is rendered. This is a test-runner compatibility issue, not an application build failure.

**How to apply:** Prefer narrow router-hook mocks for isolated component tests. Only change the shared Jest resolver if tests genuinely need a real router context, then verify the full frontend suite.