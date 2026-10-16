import type { Node } from "web-tree-sitter";
import { isParsed, parseSource } from "./parser.ts";

interface SyntaxErrors { count: number; firstLine?: number }

function errors(root: Node): SyntaxErrors {
  if (!root.hasError) return { count: 0 };
  const pending = [root];
  let count = 0, firstLine: number | undefined;
  while (pending.length) {
    const node = pending.pop()!;
    if (node.isError || node.isMissing) {
      count++;
      firstLine ??= node.startPosition.row + 1;
      continue;
    }
    const children = node.children;
    for (let index = children.length - 1; index >= 0; index--) {
      if (children[index]!.hasError) pending.push(children[index]!);
    }
  }
  return { count, ...(firstLine === undefined ? {} : { firstLine }) };
}

/** Report only parser errors introduced by a source change. Parsing is optional. */
export async function introducedSyntaxErrors(path: string, before: string, after: string):
Promise<SyntaxErrors | undefined> {
  if (before === after) return;
  try {
    const old = await parseSource(path, before);
    if (!isParsed(old)) return;
    try {
      const previous = errors(old.tree.rootNode).count;
      const fresh = await parseSource(path, after);
      if (!isParsed(fresh)) return;
      try {
        const current = errors(fresh.tree.rootNode);
        if (current.count <= previous) return;
        const count = current.count - previous;
        if (previous > 0 || current.firstLine === undefined) return { count };
        return { count, firstLine: current.firstLine };
      } finally { fresh.tree.delete(); }
    } finally { old.tree.delete(); }
  } catch { return; }
}
