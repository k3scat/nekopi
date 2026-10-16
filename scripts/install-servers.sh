#!/bin/sh
# User-invoked server provisioning at pinned versions; never run automatically.
# Inspect with --print before installing. Verify pins before updating them.
set -eu


TYPESCRIPT_VERSION=5.9.3
TYPESCRIPT_SERVER_VERSION=5.0.0
PYRIGHT_VERSION=1.1.414
BASH_SERVER_VERSION=5.8.1
GOPLS_VERSION=v0.18.1

PRINT_ONLY=0
LANGUAGES=""

usage() {
  cat <<'USAGE'
Usage: install-servers.sh [--print] [LANGUAGE...]

Languages: typescript (also tsx, javascript), python, go, bash, all
           rust, cpp, java are not installed by this script; see the notes it prints.

  --print   Show the commands without running them.

With no language, reports what is already installed and exits.
USAGE
}

for argument in "$@"; do
  case "$argument" in
    --print) PRINT_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "install-servers.sh: unknown option $argument" >&2; usage >&2; exit 2 ;;
    all|typescript|tsx|javascript|python|go|bash|rust|cpp|java)
      LANGUAGES="$LANGUAGES $argument" ;;
    *) echo "install-servers.sh: unknown language $argument" >&2; exit 1 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

# Search the default locations used by nekopi's language server resolver.
locate() {
  if command -v "$1" >/dev/null 2>&1; then command -v "$1"; return 0; fi
  directory=$(pwd -P)
  depth=0
  while [ "$depth" -lt 12 ]; do
    for bin in node_modules/.bin .venv/bin venv/bin .direnv/bin; do
      if [ -f "$directory/$bin/$1" ] && [ -x "$directory/$bin/$1" ]; then
        echo "$directory/$bin/$1"
        return 0
      fi
    done
    [ "$directory" = / ] && break
    directory=${directory%/*}
    [ -n "$directory" ] || directory=/
    depth=$((depth + 1))
  done
  for directory in "$HOME/.local/bin" "$HOME/go/bin" "$HOME/.cargo/bin" \
    "$HOME/.local/share/nvim/mason/bin" "$HOME/.bun/bin"; do
    if [ -f "$directory/$1" ] && [ -x "$directory/$1" ]; then echo "$directory/$1"; return 0; fi
  done
  return 1
}

run() {
  if [ "$PRINT_ONLY" -eq 1 ]; then
    printf '%s\n' "$*"
  else
    printf '  running: %s\n' "$*"
    "$@"
  fi
}

report() {
  echo "Installed language servers:"
  for binary in typescript-language-server pyright-langserver basedpyright-langserver \
    gopls bash-language-server rust-analyzer clangd jdtls; do
    if found=$(locate "$binary"); then
      printf '  %-28s %s\n' "$binary" "$found"
    else
      printf '  %-28s -\n' "$binary"
    fi
  done
  echo
  echo "Run with a language name to install one. nekopi also checks ancestor"
  echo "node_modules/.bin and virtual environments, plus common home directories."
}

need() {
  # --print generates lines for an image that will have the toolchain, so a
  # dry run must not require it on the machine writing the Dockerfile.
  [ "$PRINT_ONLY" -eq 1 ] && return 0
  if ! have "$1"; then
    echo "install-servers.sh: $1 is required for $2 but is not installed." >&2
    return 1
  fi
}

install_typescript() {
  need npm typescript || return 1
  run npm install -g "typescript@$TYPESCRIPT_VERSION" "typescript-language-server@$TYPESCRIPT_SERVER_VERSION"
}

install_python() {
  need npm python || return 1
  run npm install -g "pyright@$PYRIGHT_VERSION"
}

install_bash() {
  need npm bash || return 1
  run npm install -g "bash-language-server@$BASH_SERVER_VERSION"
}

install_go() {
  need go go || return 1
  # go install writes to GOBIN or ~/go/bin, both of which nekopi searches.
  run go install "golang.org/x/tools/gopls@$GOPLS_VERSION"
}

unsupported() {
  cat <<NOTE
install-servers.sh: $1 is not installed by this script.
  rust  rustup component add rust-analyzer
  cpp   install clangd from your distribution or an LLVM release
  java  install eclipse.jdt.ls and put its jdtls launcher on PATH
These need a toolchain or an archive this script will not guess at. Install one
yourself, then set languageServers.servers in nekopi.json if its binary is named
differently.
NOTE
}

if [ -z "$LANGUAGES" ]; then
  report
  exit 0
fi

failed=""
for language in $LANGUAGES; do
  case "$language" in
    all)
      for each in typescript python go bash; do
        "install_$each" || failed="$failed $each"
      done
      unsupported "rust, cpp and java"
      ;;
    typescript|tsx|javascript) install_typescript || failed="$failed $language" ;;
    python) install_python || failed="$failed $language" ;;
    go) install_go || failed="$failed $language" ;;
    bash) install_bash || failed="$failed $language" ;;
    rust|cpp|java) unsupported "$language" ;;
    *) echo "install-servers.sh: unknown language $language" >&2; failed="$failed $language" ;;
  esac
done

if [ -n "$failed" ]; then
  echo "install-servers.sh: failed for$failed" >&2
  exit 1
fi

[ "$PRINT_ONLY" -eq 1 ] || { echo; report; }
