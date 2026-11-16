## What & why

<!-- Brief description of the change and the motivation. -->

## Checklist

- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass locally
- [ ] e2e specs updated if UI/boot behaviour changed (`npm run test:e2e`)
- [ ] **`docs/ARCHITECTURE.md` reviewed** — updated if this PR changes a
      module's responsibility, the data contract / `SCHEMA_VERSION`, the
      `StorageAdapter` interface, the Workbench ↔ React state contract, how
      persistence/sync/the test API are wired, or a cross-cutting invariant.
      (Tick even if no update was needed — confirming you checked.)
- [ ] `docs/UI_AUDIT.md` status updated if this PR addresses an audit item
