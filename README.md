# NekoPi

```text
 _   _      _        ____  _
| \ | | ___| | _____|  _ \(_)   /\_/\
|  \| |/ _ \ |/ / _ \ |_) | |  ( o.o )
| |\  |  __/   < (_) |  __/| |   > ^ <
|_| \_|\___|_|\_\___/|_|   |_|
```

Another flavor of [Pi](https://github.com/earendil-works/pi). Same agent loop,
providers, sessions and extensions. A smaller tool surface: `bash`, with source
operations behind `nek`.

```sh
nek grep 'parse|decode' src --context 2
nek read src/parser.ts --symbol parse
nek patch --check < fix.diff
nek patch < fix.diff && npm test
```

Search hits carry declaration labels. Long reads carry a symbol map. Output is
bounded; when it stops short, it says so. The point is less machinery between
the agent and the repository—not a new agent framework.

In our 300-task SWE-bench Multilingual run with `gpt-6-luna:high`,
NekoPi achieved ~15% less estimated model cost than plain Pi; results vary by model
and workload.

## Run it

Install a published release with Node **22.19+** and npm:

```sh
npm install --global nekopi
nekopi
```

Install Git and `rg` separately. To run from source:

Use Bun **1.2.18** to install and build, Node **22.19+** to launch, and an
installed `rg` for search. The development dependencies pin Pi **1.3.0**.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
node bin/nekopi.mjs doctor
node bin/nekopi.mjs
```

Inside the session: `/login`, then `/model`. NekoPi shares Pi's agent directory,
normally `~/.pi/agent`; `PI_CODING_AGENT_DIR` selects another one. It does not
create a second credential store.

To launch from other repositories, put this checkout's `bin` directory on your
`PATH`. `nek` is made available to the agent's shells automatically.

```sh
export PATH="/absolute/path/to/nekopi/bin:$PATH"
cd /path/to/your/project
nekopi
```

Normal Pi options pass through, including `-p`, `--provider`, `--model` and
`--no-extensions`. The last one disables NekoPi's extension and header too.
For an existing Pi installation, load NekoPi without its launcher:

```sh
pi -e /absolute/path/to/nekopi
```

Do not load two copies of the extension. This mode keeps Pi's own header.

## What's here

- `nek grep`, `find`, `read`, `patch`, `edit`, `write`: source work through the shell.
- Optional web search: a direct answer with sources.
- Optional image generation: a background job, then a completion message.
- `/nekopi config|stats|lsp|prompt`: inspect the session, not another control panel.

Web, images and local telemetry are off by default. Language servers are only
used by optional diagnostics in native-tool mode; ordinary `nek` source work
does not need one. Other extensions can still add tools.

NekoPi is **not a sandbox**. Bash and extensions have the host process's
permissions. Workspace path checks on specific commands do not change that.

## Read next

- [Tools](docs/tools.md) — commands, output and limits.
- [Configuration](docs/configuration.md) — settings, logins and local data.
- [Development](docs/development.md) — internals, checks and design decisions.
- [CLI performance](docs/performance.md): profiling, measured results and remaining costs.
- [Releases](docs/releases.md) — CI, versioning, npm publishing, and maintainer setup.

`nek --help` is the command index. `nek image --help` has the longer image guide.
`bun run budget` measures prompt overhead; it does not measure coding ability.

MIT licensed. Built on Pi, not a fork of it.
