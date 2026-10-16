# CLI performance

## Profile a checkout

Build first, then run the benchmark with Node. No model or provider login is needed.
These timings cover `nek` and `nekocli`, not the interactive `nekopi` application.

```sh
bun run build
node scripts/profile-cli.mjs --runs 5 --out /tmp/nek-profile.json
```

The script creates a temporary workspace with 5,025 TypeScript source files,
439,051 source lines and about 7.6 MiB of source text. It includes 24 larger files
with 1,201 functions each. Only this temporary workspace is modified.

Every sample starts a new CLI process. One initial sample is recorded separately,
then the script reports the median and 95th percentile of the remaining samples.
The filesystem cache is not cleared. These are process startup and command timings,
not uncached disk benchmarks. JSON reports include individual samples and output sizes.

Use the printed fixture path to compare builds with the same input:

```sh
node scripts/profile-cli.mjs --fixture /tmp/nek-cli-profile-EXAMPLE --cli /path/to/baseline/bin/nekocli.mjs --out /tmp/nek-before.json
node scripts/profile-cli.mjs --fixture /tmp/nek-cli-profile-EXAMPLE --out /tmp/nek-after.json
```

Add `--runtime bun` to measure Bun instead of Node. Use `--help` for all options.
The benchmark script is a development tool in the repository checkout.

For a CPU profile, run a built command with Node:

```sh
node --cpu-prof bin/nekocli.mjs --help
node --cpu-prof bin/nekocli.mjs grep 'your pattern' src
```

## Measured changes

The comparison below uses baseline commit `da1f1d9` and the optimized checkout,
on Linux x64 with Node 24.15.0 and Bun 1.2.18. Both builds use the same dependency
installation and fixture. Values are median milliseconds from five samples.
They are examples, not performance guarantees for other machines or repositories.

| Command | Node before | Node after | Bun before | Bun after |
| --- | ---: | ---: | ---: | ---: |
| Help | 433 | 28 | 258 | 26 |
| Find | 435 | 35 | 261 | 36 |
| Search without matches | 454 | 39 | 263 | 39 |
| Search with file output | 434 | 38 | 254 | 35 |
| Search with labels in 24 large files | 981 | 384 | 986 | 451 |
| Read a small complete file | 481 | 29 | 301 | 30 |
| Read selected lines | 462 | 30 | 279 | 30 |
| Read a symbol in a large file | 509 | 84 | 341 | 107 |
| Find a declaration by name | 473 | 58 | 308 | 71 |
| Write | 432 | 31 | 261 | 34 |
| Patch validation | 447 | 36 | 277 | 39 |

The published `1.0.0` package was also measured. Its Node medians were 354 ms for
find, 347 ms for selected lines and 922 ms for search with labels in large files.
Dependency installation layout affects startup, so the table uses the controlled
checkout comparison rather than mixing installation layouts.

Read-only checks on the NekoPi repository also improved: find was 436 to 40 ms,
search in `symbols.ts` was 476 to 70 ms, selected lines were 439 to 30 ms, and a
symbol read was 459 to 63 ms. Source output matched the baseline byte for byte;
find paths matched after sorting, since traversal order is not guaranteed.

## What changed and what did not

CLI search and discovery use the same execution code as native tools, without
loading Pi's session and UI modules. Text selections use shared range formatting.
Small complete text reads avoid both native tool setup and syntax initialization.
Search outlines skip subtrees that cannot contain a matching line. File heading
accounting uses a set instead of repeated scans.

There is no background service, persistent source index or stale file cache.
Syntax parsing still reads current file contents and keeps its existing size limit.
Search limits, context, encoding notices, failure statuses and workspace guards remain.

Native tool adapters keep their public schemas and rendering. Image reads,
special path syntax, invalid UTF-8, large files and reads that need native clipping
retain native handling. Fast text selection uses one bounded snapshot for both
symbol selection and output. Unsupported cases fall back rather than lose features.
Fast text reads currently apply to simple ASCII relative paths on POSIX. Windows
and other path forms keep native handling.

Edit still uses Pi's native matching and recovery. Large ordinary previews also
retain native reads. These paths have no major speed improvement: controlled Node
medians were 445 to 398 ms for edit and 518 to 479 ms for a large preview; the Bun
preview was 338 to 346 ms. Focused reads are faster, but no command is removed.

Functional regression tests compare fast output with native output and ensure that
common built CLI commands work when Pi SDK imports are blocked. Timing assertions
are not used in CI because host load can make them unreliable.
