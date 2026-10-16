# Development

NekoPi is a launcher and a Pi extension. There is no second agent loop.

## Work on it

Use the versions in [package.json](../package.json) and the committed lockfile.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run dev
```

Before handing off a change:

```sh
bun run check
```

That lints, builds, type-checks, runs offline unit/SDK tests, then smoke-checks the Node
launcher. Build comes first because some tests exercise `dist`. The checks do not
call a live model or validate your provider login. Run focused tests while editing;
run the whole gate before calling a change done.

`bun run lint` runs Oxlint without formatting changes. Control-character regexes
are allowed because source rendering and terminal-output handling need them.
See [Releases](releases.md) for commit conventions and publishing setup.

## Code map

| Location | Responsibility |
| --- | --- |
| [src/cli.ts](../src/cli.ts), [bin/](../bin/) | Launcher, local commands, Pi option passthrough |
| [src/index.ts](../src/index.ts) | Lifecycle, tool selection, prompt sections, session commands |
| [src/branding.ts](../src/branding.ts) | Standalone TUI header through Pi's public UI API |
| [src/config.ts](../src/config.ts) | Strict NekoPi settings, trust and value origins |
| [src/nekocli.ts](../src/nekocli.ts), [commands.ts](../src/tools/commands.ts) | CLI dispatch and declared command surface |
| [patch.ts](../src/tools/patch.ts), [patch/](../src/tools/patch/) | Diff/envelope parsing, hunk placement and Git application |
| [search.ts](../src/tools/search.ts), [find.ts](../src/tools/find.ts) | ripgrep scans, ignore rules and bounded results |
| [read/](../src/tools/read/), [syntax/](../src/tools/syntax/) | Snapshots, symbols, ranges and grammar support |
| [edit/](../src/tools/edit/) | Match recovery and optional native-tool diagnostics |
| [bash/](../src/tools/bash/) | Built-in Bash feedback and session bridges |
| [hosted.ts](../src/tools/hosted.ts), [web.ts](../src/tools/web.ts), [image.ts](../src/tools/image.ts) | Hosted request routing and response handling |
| [image-jobs.ts](../src/tools/image-jobs.ts) | Session-owned background jobs and cancellation |
| [lsp/](../src/tools/lsp/), [typescript/](../src/tools/typescript/) | Language-server and project-compiler clients |
| [telemetry.ts](../src/telemetry.ts), [stats.ts](../src/stats.ts), [adoption.ts](../src/adoption.ts) | Local metadata and reports |

Text uses ripgrep. Syntax uses tree-sitter without a server. Optional diagnostics
use an installed language server or project TypeScript compiler. Missing grammars
or servers should remove detail, not prevent ordinary source work.

## Design

Keep the part that earns its place. Prefer useful defaults over another selector.

- Put structural context on calls the agent already makes: grep hits and long reads.
- Keep always-loaded instructions small. Put uncommon guidance behind `--help`.
- Return source, locations and actionable failures. Report limits when reached;
  keep diagnostic accounting in structured details when it does not change a decision.
- Bound input, output, pending work and session-owned resources.
- Do not silently install servers, switch credentials or change billing routes.
- Use Pi's public APIs. Keep its tool overrides, allowlists and custom prompts working.

Fewer schemas or calls can reduce prompt overhead. That alone proves neither a
cheaper task nor a better fix. Claims about outcomes need reproducible matched
tasks, verification and complete usage accounting. This repository does not
publish such a benchmark. Historical local experiments are not product guarantees.

## Measure the prompt

```sh
bun run budget
bun run budget --json
bun run budget --save
```

The script captures a real offline SDK request and counts system sections and
tool definitions with `o200k_base`. Absolute paths are normalized. The resulting
[prompt-budget.json](prompt-budget.json) is the versioned baseline, not a pricing
model. Inspect the output instead of copying token totals into several guides.

[budget.test.ts](../tests/budget.test.ts) checks growth tolerance and the tool set.
Save a new baseline deliberately when the surface changes. Optional hosted-tool
instructions are only loaded when enabled; the default baseline does not include
them. A smaller prompt is a measurement, not a task-success result.

## Extension lifecycle

Initialize session resources from `session_start`, not module import. Tool
replacement happens in `resources_discover`, after startup definitions exist.
Preserve user/SDK overrides and inactive tools; do not replace by name alone.
The plain-Pi package entry does not install the standalone branding extension.

Bash result hooks compose. Preserve `structuredContent` when returning visible
content, so later hooks retain the complete output and exit status. Image reads
attach blocks through the image bridge; hosted requests use signed session-bound
markers. Each fresh request has a nonce so repeated queries are not replayed markers.

Web returns directly. Images return job IDs and finish through
`pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`. Job records
contain no persisted credentials. Keep concurrency/history bounded, make status
read-only, and do not let a cancelled or closed job publish a late result.
Credentials stay inside the session; this is routing hygiene, not a sandbox.

On `session_shutdown`, abort jobs, close telemetry, remove image sidecars and
dispose server/parser resources. SDK hosts must emit shutdown before disposing
the session. Reload and session replacement must not deliver results into the
next session. Image files already written remain on disk.

## Language support

[Syntax rules](../src/tools/syntax/languages.ts) map extensions and grammar nodes
to declarations. Test source fidelity, nested names, ambiguous symbols, missing
grammars and oversized files. Trees are deleted after use, not cached across edits.

[Server recipes](../src/tools/lsp/servers.ts) contain binaries, arguments and root
markers. [The scripted server](../tests/helpers/lsp-server.mjs) exercises protocol
behavior offline. Cold indexing, process exit and timeouts need explicit tests.
Surface an unavailable server rather than treating silence as proof of absence.
Installation hints belong in the human-facing `lsp` report, not agent results.
The compiler preflight is not a sandbox against concurrent configuration changes.

## Branding and upgrades

Write **NekoPi** in prose and UI. Keep `nekopi`, `nekocli`, `nek`, configuration
keys and existing paths lowercase. Pi remains credited as the host.

The standalone wordmark uses `ctx.ui.setHeader()`, with theme colors and a
narrow-terminal fallback. It adds no model instructions, animation, custom
footer or TUI dependency. Non-TUI modes do not install a header; Pi's
`quietStartup` is respected unless `--verbose` is supplied. Other UI extensions
can replace it. Pi's title and other built-in branding remain upstream-owned.

Do not patch `node_modules`, alter Pi's package metadata or intercept terminal
output to erase its name. Those approaches create an upgrade obligation for a
cosmetic change. Public hooks are a smaller obligation, not a guarantee that a
future Pi release cannot break them. [Appearance settings](configuration.md#appearance).

Pi packages are peers with a `^1.3.0` range and exact development pins. CI runs
the declared Node floor and a newer Node version. Its additional `latest-pi`
job is allowed to fail; it is an upgrade warning, not a compatibility guarantee.
Keep TypeBox aligned with Pi's pin when upgrading it. Run the full gate against
the new dependency versions, including TUI header and SDK lifecycle tests.

## Documentation

README gets someone running. The tool reference owns command behavior and limits.
Configuration owns settings, auth and local data. This file owns internals and
tradeoffs. Keep each fact in one place and link to it from elsewhere.

Check local links, CLI examples, documented defaults and actual output after
changing an interface. Avoid fixed test counts, latency claims and copied token
figures. Keep generated budget data generated. The local, ignored benchmark
harness is not required to build or test this package.
