# Configuration

Pi owns models, credentials, sessions, themes and keybindings. Use its `/login`,
`/model` and `/settings` commands for those. NekoPi's settings live separately:

1. Built-in defaults.
2. `<agent directory>/nekopi.json`, normally `~/.pi/agent/nekopi.json`.
3. `.pi/nekopi.json` in the working directory, only after Pi trusts that project.

`PI_CODING_AGENT_DIR` changes the agent directory. Files are strict JSON, limited
to 64 KiB. Unknown keys and invalid values are rejected. Sections merge by field;
a supplied `languageServers.servers` map replaces the lower-precedence map.
Use `/reload` after changing settings. Reload cancels unfinished image jobs.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `nekocli.enabled` | `true` | Source operations through `nek`; the agent gets `bash` instead of separate source tools |
| `languageServers.enabled` | `true` | Allow an installed language server or project compiler to start when needed |
| `languageServers.servers` | — | Server recipe overrides; see below |
| `diagnostics.enabled` | `false` | Before/after file diagnostics on native edit and write tools in trusted projects |
| `web.enabled` | `false` | Enable `nek web` using supported chat credentials or a separate Codex login |
| `image.enabled` | `false` | Enable background `nek image` jobs using a Codex subscription login |
| `telemetry.enabled` | `false` | Write local metadata logs for cross-run statistics |

Missing values keep their defaults. For example:

```json
{
  "web": { "enabled": true },
  "image": { "enabled": true }
}
```

`nekocli.enabled: false` keeps separate native source tools, with NekoPi's read
and edit feedback. The same fallback is used when the `nek` launcher is missing.
With no native Bash tool active, the hosted commands and their prompt blocks are
not enabled. User tool overrides and explicit SDK tool selections take priority.

`diagnostics.enabled` only works in native-tool mode and also needs
`languageServers.enabled`. In default shell mode it produces a notice, not a
diagnostic report. Bash edits are not observed. Diagnostics cover the changed
file, not the project or tests, and may include pre-existing errors. A failed
query does not undo the edit.

## Personality

`PERSONA.md` replaces the default opening identity, not the rest of the generated
system prompt. It does not change tools, permissions, workflow rules, skills,
`AGENTS.md` context, or `APPEND_SYSTEM.md` content. Character instructions can
still affect model behavior, so keep the file consistent with your work rules.

1. The global file is `<agent directory>/PERSONA.md`, normally
   `~/.pi/agent/PERSONA.md`. `PI_CODING_AGENT_DIR` changes this location.
2. In trusted projects, NekoPi searches from the working directory up to the
   filesystem root. The nearest `PERSONA.md` replaces the global persona.
3. Project personas are not read in untrusted projects. Revoking trust uses the
   global persona on the next request. After granting trust, use `/reload`.
4. An empty selected file keeps the default identity. An empty project file
   therefore disables a global persona for that project.
5. `SYSTEM.md`, `--system-prompt`, and custom system prompts from extensions take
   priority. Persona files are not read for these prompt replacements.

Files must be regular UTF-8 files of at most 64 KiB. Invalid active files produce
an error and stop the request before it reaches the model. Persona contents are
loaded on the first request or prompt inspection and kept until `/reload`.
Reload after editing, creating, or deleting a file. There is no file watcher,
additional CLI command, or JSON setting. `/nekopi prompt` shows the persona in
the existing prompt viewer; edits in that viewer are still discarded.

## Web and image logins

**Web prefers supported coding-model credentials.** OpenAI API keys and direct-use
`openai` ChatGPT OAuth go to the OpenAI Responses API. Codex subscription tokens
go to the Codex Responses endpoint. If the coding model has no supported hosted
credential, web uses your separate `/login openai-codex` login with `gpt-6.1-sol`.
Your custom coding model stays selected; gateway credentials and headers are not
forwarded to OpenAI. No extra setting is needed. The search model and account
must support web search; provider request failures are not retried with another
login or model.

**Images use `openai-codex`.** Run `/login openai-codex`. Images use that login
regardless of the coding model; direct-use `openai` OAuth is not an image login.
If you also code through `openai-codex`, one login can cover all three features,
subject to model availability and account policy. Otherwise, keep your existing
coding login and add Codex alongside it.

Images currently use `gpt-image-2` through private Codex generation/edit endpoints.
Those endpoints can change. There is no automatic paid-API fallback or model
switch. Missing image auth is reported as a failed job with login guidance.

Both features make additional provider requests. They can consume included or
billed usage; NekoPi does not calculate their bill. Image completion can wake an
idle agent for another coding-model turn. Do not treat the local usage counters
as a complete receipt for hosted tools. The [image reference](tools.md#image)
describes job lifetime and cancellation.

Credentials are resolved inside the session, not exported by these commands to
the agent's shell. A signed, session-bound request connects `nek` to the session.
Fresh requests can repeat a query; replayed markers are ignored. Web text is
untrusted retrieved content, not instructions.

## Language servers

Normal `nek` search and reading use ripgrep and tree-sitter, not a language server.
`nekopi lsp` reports detection; it does not start a semantic query. Servers are
started on demand for diagnostics. NekoPi does not install them during a task.

Automatic diagnostics require a trusted project, even when enabled in user
settings. Otherwise native edits and writes continue without starting a server
or loading the project's TypeScript compiler. Trust the project and reload to
enable diagnostics. Revoking trust stops diagnostics at the next use and closes
the existing semantic layer. Server detection with `nekopi lsp` does not execute
servers and remains available in untrusted projects.

Discovery checks `PATH`, ancestor project binaries and common user locations.
Built-in recipes cover TypeScript/TSX/JavaScript, Python, Go, Rust, C/C++, Java
and shell. TypeScript/JavaScript can fall back to the project's own TypeScript
server. Missing or failed servers leave source commands available.

```json
{
  "languageServers": {
    "servers": {
      "go": { "command": "/opt/bin/gopls", "args": ["-rpc.trace"] },
      "zig": { "command": "zls", "extensions": [".zig"] }
    }
  }
}
```

An override accepts `command`, `args`, `rootMarkers`, `extensions` and
`initializationOptions`. Unspecified fields use the built-in recipe, when one
exists. Arguments replace the recipe's arguments. A language without a recipe
needs a command; extensions associate its files with that language. These are
programs running with your permissions, not sandboxed plugins.

Provision servers yourself, or inspect the pinned installer before using it:

```sh
sh scripts/install-servers.sh                 # report installed servers
sh scripts/install-servers.sh --print all     # print commands only
sh scripts/install-servers.sh python go       # install these
```

## Inspect and troubleshoot

| Command | Shows |
| --- | --- |
| `nekopi doctor` | Runtime, launcher, ripgrep, grammars, settings and server checks |
| `nekopi inspect` | Effective NekoPi settings, sources and field origins |
| `nekopi inspect --trust-project` | Include project settings for this inspection; does not grant Pi trust |
| `nekopi lsp` | Server detection and installation hints, without a provider login |
| `nekopi adoption --days 7` | Tool counts from enabled telemetry logs |
| `/nekopi config` | Effective configuration in a session |
| `/nekopi stats` | Current-session tool counts and provider-reported model usage |
| `/nekopi lsp` | Server detection in the current workspace |
| `/nekopi prompt` | The assembled system prompt |

`/nekopi` defaults to `config`. These session commands use Pi's editor as a
viewer; edits in that viewer are discarded. `doctor` returns nonzero for missing
required parts, but does not test provider logins or make generation requests.

Retired sections (`sourceTools`, `delegation`, `codeIntelligence`, `output`) are
rejected with migration guidance. Use `languageServers` instead of
`codeIntelligence`; the others have no current counterpart.

## Local data

In-memory counters work with telemetry off. In default mode they count `bash`
executions, not individual `nek` operations inside a shell command.

With telemetry enabled, `<agent directory>/nekopi/telemetry/` gets a JSONL file
per run. Records contain session/tool/model identifiers, timing, error flags,
text byte counts and provider-reported model usage. NekoPi's telemetry excludes
prompts, arguments, file contents, outputs and credentials. Pi's own sessions
are separate and can contain conversation and tool content.

Logs use private permissions, a 10 MiB run limit and a 128-record pending queue.
Storage failure stops logging, not the agent. There is no automatic log deletion.
Durations can overlap and output bytes exclude image data and later context
repetition; neither is an elapsed-time or billing measure.

Image job records are memory-only. Generated PNGs stay at the requested workspace
paths. Reading an image uses a temporary sidecar consumed by the session; closing
the session cleans up its image bridge. [Tool limits](tools.md#read) still apply.

## Appearance

The standalone `nekopi` launcher replaces Pi's startup logo and key-hint block
with one line: `NekoPi <version> / Pi <version>`. It uses Pi's theme colors and
leaves the footer, terminal title, dialogs and other Pi UI alone. `/help` still
lists Pi's commands and shortcuts.

This uses the public `ctx.ui.setHeader()` extension hook, not modified dependency
files. Loading NekoPi into an existing Pi session leaves the header alone. Other
UI extensions can replace the header in extension order.

To hide the startup header and resource listing, set `"quietStartup": true` in
**Pi's `settings.json`**, not `nekopi.json`. Pi's `--verbose` overrides that quiet
startup for the standalone header. NekoPi does not rewrite your Pi settings.
