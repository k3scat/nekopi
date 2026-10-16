# Releases

## Pipeline

[check.yml](../.github/workflows/check.yml) runs on pull requests and pushes to
`main`. Required checks run lint, build, type checking, offline tests, package
content checks, and launcher smoke tests on Node 22.19.0 and 24.15.0. A separate
latest-Pi compatibility job can fail without blocking a release.

Only a successful push build on `main` can reach the release job. It uses the
GitHub environment `npm` and semantic-release to calculate a version, create a
Git tag, publish to npm, and create GitHub release notes with a package archive.
Pull requests receive no publishing credentials. Main-branch runs are serialized;
newer pull-request runs can cancel older ones.

The npm `prepare` hook rebuilds the package after semantic-release sets its
version. Published binaries therefore report the release version, not the
development version in the source tree. Versions are not committed back to
`main`; tags and npm are the release record. There is no generated changelog or
release commit.

## Commit conventions

Use Conventional Commits, including the title when squash-merging a pull request.

| Commit | Release |
| --- | --- |
| `fix: correct image validation` | Patch |
| `feat: add source navigation` | Minor |
| A commit with a `BREAKING CHANGE:` footer | Major |
| `docs:`, `test:`, or `chore:` alone | None |

Without a previous release tag, the first qualifying release is `1.0.0`.
After the one-time bootstrap below, do not publish versions or move release tags
manually.

## GitHub setup

1. Create an environment named `npm` under repository Settings, Environments.
   Restrict deployments to `main`. Required reviewers are optional.
2. Allow GitHub Actions to request `contents: write` and `id-token: write` for
   the release job. Other jobs have read-only repository access.
3. Protect `main` with pull requests and both Node check jobs. The latest-Pi job
   is advisory and must not be required.
4. If tag rules are enabled, permit the release workflow to create `v*` tags.

`GITHUB_TOKEN` is supplied automatically by GitHub Actions. No GitHub personal
access token is required. Issue and pull-request comments and labels are disabled,
so the release job does not need issue or pull-request write permissions.

## Trusted publishing

CI uses npm trusted publishing only. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN`
secrets. No custom pipeline variables are required.

The `nekopi` package must exist before npm can configure its trusted publisher.
If it does not exist yet, make one manual bootstrap publication from a checked
checkout using your npm account and its normal two-factor authentication:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
npm login
npm publish --access public --provenance=false
```

Local publishing cannot produce GitHub Actions provenance, so only this bootstrap
publication disables it. It publishes the development manifest version, currently
`0.1.0`. The first automated semantic release is `1.0.0`. Never commit npm
credentials or a local `.npmrc`.

In npm package settings, add a GitHub Actions trusted publisher with these exact
values:

| Field | Value |
| --- | --- |
| Repository owner | `k3scat` |
| Repository name | `nekopi` |
| Workflow filename | `check.yml` |
| Environment | `npm` |

Alternatively, register it from an interactive terminal with npm's CLI:

```sh
npm trust github nekopi --file check.yml --repository k3scat/nekopi --environment npm --yes
```

Publishing and trusted-publisher changes can require a new browser or two-factor
approval even when `npm whoami` succeeds.

Allow direct publishing and dist-tag management when npm presents those options.
Once checks pass, approve the waiting `npm` deployment. If the initial run has
already failed, rerun it after completing npm setup.

Complete a trusted publication promptly after configuring the publisher, following
any expiry shown by npm. After it succeeds, disallow token-based publishing in npm
package settings. Keep the workflow on GitHub-hosted runners and retain its
`id-token: write` permission for trusted publishing and provenance. Automated
publications include provenance.
Remove the environment's required-reviewer rule if releases should proceed
automatically after checks pass.

## Local verification

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
npm pack --dry-run --ignore-scripts
```

Do not run `bun run release` locally. It is the publishing command, not a local
test. The offline checks do not validate registry credentials, GitHub environment
rules, or the first live trusted publication.
