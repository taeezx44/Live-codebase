## What does this PR do?

<!-- One paragraph. What problem does it solve or what feature does it add?
     Link to the issue it closes if there is one: "Closes #123" -->



## How does it work?

<!-- For non-trivial changes: explain the approach. If you considered
     alternatives and rejected them, say so — it saves reviewers from
     suggesting those alternatives. Skip this section for docs/trivial fixes. -->



## How to test it?

<!-- What should a reviewer do to verify this works?
     A curl command, a test command, or a sequence of UI steps. -->

```bash
# example
pnpm test --filter @codevis/analysis-engine
```

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm lint` passes
- [ ] New behaviour has tests (see CONTRIBUTING.md → Testing)
- [ ] CHANGELOG.md updated under `[Unreleased]`
- [ ] Screenshots or recording attached (for any UI change)
