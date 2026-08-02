# OpenCode Debate v2.2.0 Release Design

## Goal

Audit the public README, prepare a backward-compatible `2.2.0` release, and publish it through the repository's established GitHub Release OIDC workflow.

## Compatibility and version

Release `v2.2.0` as a stable minor release. Existing complete version 2 participant configurations remain valid because `sets.<name>.continuation` is optional and defaults to `ask`. Existing exported function calls remain valid because new parameters and registry fields are optional or defaulted. Stricter JSON and transcript parsing rejects ambiguous malformed input rather than changing valid input semantics.

The npm registry currently reports `opencode-debate@2.1.0` and `latest: 2.1.0`. Local npm authentication is unavailable, so publication must use the proven GitHub OIDC workflow rather than a direct local `npm publish`.

## README audit

Update only stale or incomplete public documentation:

- Change the version badge and pinned installation example from `2.1.0` to `2.2.0`.
- Clarify the round-limit step in **How It Works** so it acknowledges per-set `ask` and `discretion` continuation behaviour.
- Clarify **Verification** so it names both Python response-formatter and HTML-generator tests.

Retain the existing requirements, formatter semantics, coordinator-only permission explanation, continuation configuration details, tokenised multiline topic format, restart guidance, and project-structure entries because they already match the implementation.

## Release metadata

- Set `package.json` version to `2.2.0`.
- Update only the root package version fields in `package-lock.json`; do not update dependency resolutions.
- Update hard-coded README version assertions in `scripts/verify.sh` to `2.2.0`.
- Do not add dependencies, change the publish workflow, or introduce a changelog file.

## Validation

Before pushing or creating a release, run:

1. `python3 -m unittest discover -s tests -p 'test_*.py'`
2. `npm test`
3. `npm run typecheck`
4. `npm run pack:check`
5. `sh scripts/verify.sh`
6. `npm pack --dry-run --json`
7. `git diff --check`

Inspect the dry-run package manifest to confirm the release contains only the package allowlist and reports version `2.2.0`.

## Publication flow

1. Commit release preparation as `Bump package version to 2.2.0`.
2. Push `main` to `origin`.
3. Wait for the pushed verification workflow to succeed.
4. Create stable GitHub Release `v2.2.0` targeting the verified release commit, with concise notes covering strict response formatting, per-set continuation discretion, and multiline topic preservation, plus a compare link from `v2.1.0`.
5. Monitor the release-triggered **Publish npm package** workflow until it succeeds.
6. Verify the npm registry reports `opencode-debate@2.2.0` and `latest: 2.2.0`.

## Failure handling

- If local validation or pushed CI fails, do not create the release; fix and revalidate first.
- If the publish workflow fails before npm accepts the version, inspect the workflow and rerun it only after correcting the cause.
- Do not publish locally or create a replacement tag as a workaround.
- Once npm accepts `2.2.0`, treat it as immutable and report any later verification discrepancy explicitly.
