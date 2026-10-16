import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";

/**
 * A language server recipe.
 *
 * The launch knowledge for a server reduces to a binary name, its arguments and
 * sometimes an initialization option block. Nekopi discovers an installed
 * server; it never downloads or installs one.
 */
interface ServerRecipe {
  /** Binary names to try, in preference order. */
  commands: readonly string[];
  args: readonly string[];
  /** Server-specific `initializationOptions`. */
  initialization?: Record<string, unknown>;
  /** Files that mark the project root for this language. */
  rootMarkers: readonly string[];
  /** How a user installs it, shown by `/nekopi lsp` and never to the model. */
  install: string;
}

/** Language id to recipe. Language ids match the syntax layer. */
export const RECIPES: Record<string, ServerRecipe> = {
  typescript: {
    commands: ["typescript-language-server"],
    args: ["--stdio"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    install: "npm i -g typescript typescript-language-server",
  },
  tsx: {
    commands: ["typescript-language-server"],
    args: ["--stdio"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    install: "npm i -g typescript typescript-language-server",
  },
  javascript: {
    commands: ["typescript-language-server"],
    args: ["--stdio"],
    rootMarkers: ["jsconfig.json", "tsconfig.json", "package.json"],
    install: "npm i -g typescript typescript-language-server",
  },
  python: {
    commands: ["basedpyright-langserver", "pyright-langserver", "pylsp"],
    args: ["--stdio"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
    install: "uv tool install basedpyright, or npm i -g pyright",
  },
  go: {
    commands: ["gopls"],
    args: [],
    rootMarkers: ["go.mod", "go.work"],
    install: "go install golang.org/x/tools/gopls@latest",
  },
  rust: {
    commands: ["rust-analyzer"],
    args: [],
    rootMarkers: ["Cargo.toml"],
    install: "rustup component add rust-analyzer",
  },
  cpp: {
    commands: ["clangd"],
    args: ["--background-index"],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", "CMakeLists.txt", "Makefile"],
    install: "install clangd from your package manager or LLVM release",
  },
  java: {
    // jdtls needs a writable workspace directory; session.ts supplies one.
    commands: ["jdtls"],
    args: [],
    rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", ".classpath"],
    install: "install eclipse.jdt.ls and put its jdtls launcher on PATH",
  },
  bash: {
    commands: ["bash-language-server"],
    args: ["start"],
    rootMarkers: [".git"],
    install: "npm i -g bash-language-server",
  },
};

/** `pylsp` takes no --stdio flag; it speaks stdio by default. */
const NO_STDIO_FLAG = new Set(["pylsp", "rust-analyzer", "gopls", "clangd", "jdtls"]);

export function argsFor(recipe: ServerRecipe, command: string): string[] {
  const binary = command.slice(command.lastIndexOf(sep) + 1);
  if (NO_STDIO_FLAG.has(binary)) return recipe.args.filter(arg => arg !== "--stdio");
  return [...recipe.args];
}

/**
 * Directories searched for a server binary, beyond PATH.
 *
 * Most "missing" servers are installed but not on the PATH of the process that
 * started the agent, so look where installers actually put them.
 */
function extraDirectories(cwd: string): string[] {
  const home = homedir();
  const directories: string[] = [];
  // Walk up from the workspace so a nested package's binaries are found.
  let directory = resolve(cwd);
  for (let depth = 0; depth < 12; depth++) {
    directories.push(join(directory, "node_modules", ".bin"));
    for (const environment of [".venv", "venv", ".direnv"]) directories.push(join(directory, environment, "bin"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  directories.push(
    join(home, ".local", "bin"),
    join(home, "go", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".local", "share", "nvim", "mason", "bin"),
    join(home, ".bun", "bin"),
  );
  return directories;
}

async function executable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a binary name to a path, searching PATH and the usual install locations. */
export async function findBinary(command: string, cwd: string,
  searchPath = process.env.PATH ?? ""): Promise<string | undefined> {
  const names = process.platform === "win32" ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  const directories = [...searchPath.split(delimiter).filter(Boolean), ...extraDirectories(cwd)];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = resolve(cwd, directory, name);
      if (await executable(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface ResolvedServer {
  language: string;
  command: string;
  args: string[];
  recipe: ServerRecipe;
  /** True when a configuration override chose this server. */
  configured?: true;
}

/** Overrides keyed by language id, from `languageServers.servers`. */
export interface ServerOverrides {
  [language: string]: {
    command?: string;
    args?: string[];
    initializationOptions?: Record<string, unknown>;
    rootMarkers?: string[];
    extensions?: string[];
  } | undefined;
}

/**
 * The language an override claims for a file extension.
 *
 * The syntax layer maps an extension only when it ships a grammar for it, so an
 * override is how a tenth language reaches `lsp`. Such a language has no
 * grammar, so its queries need an explicit line and column rather than a
 * declaration name.
 */
export function overrideLanguageFor(path: string, overrides: ServerOverrides): string | undefined {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!extension) return undefined;
  for (const [language, override] of Object.entries(overrides)) {
    if (override?.extensions?.includes(extension)) return language;
  }
  return undefined;
}

/**
 * Apply an override to a recipe.
 *
 * An override exists for a server nekopi cannot guess: a wrapper script, a
 * pinned build, or options a project needs. It can also name a language with no
 * built-in recipe at all, which is how a tenth language gets support without a
 * code change.
 */
export function overrideRecipe(language: string, overrides: ServerOverrides): ServerRecipe | undefined {
  const override = overrides[language];
  const base = RECIPES[language];
  if (!override) return base;
  const command = override.command ?? base?.commands[0];
  if (!command) return undefined;
  return {
    commands: [command],
    args: override.args ?? (base ? [...base.args] : []),
    rootMarkers: override.rootMarkers ?? base?.rootMarkers ?? [".git"],
    install: base?.install ?? "configured in languageServers.servers",
    ...(override.initializationOptions ?? base?.initialization
      ? { initialization: override.initializationOptions ?? base?.initialization } : {}),
  };
}

/** The first installed server for a language, or undefined when none is present. */
export async function resolveServer(language: string, cwd: string,
  overrides: ServerOverrides = {}): Promise<ResolvedServer | undefined> {
  const recipe = overrideRecipe(language, overrides);
  if (!recipe) return undefined;
  const configured = overrides[language] !== undefined;
  for (const command of recipe.commands) {
    // An override's own arguments are used verbatim; only a guessed recipe
    // needs the stdio flag corrected for the server it found.
    const binary = await findBinary(command, cwd);
    if (binary) {
      return { language, command: binary, recipe,
        args: configured && overrides[language]?.args ? [...overrides[language]!.args!] : argsFor(recipe, binary),
        ...(configured ? { configured: true as const } : {}) };
    }
  }
  return undefined;
}

/** The project root for a language, chosen by its marker files. */
export async function serverRoot(recipe: ServerRecipe, cwd: string, file: string): Promise<string> {
  let directory = dirname(resolve(cwd, file));
  const stop = resolve(cwd);
  for (let depth = 0; depth < 24; depth++) {
    for (const marker of recipe.rootMarkers) {
      try {
        await stat(join(directory, marker));
        return directory;
      } catch { /* keep looking */ }
    }
    if (directory === stop) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return stop;
}
