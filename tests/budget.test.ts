import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { measureAll, runBudget, SHAPES, type Budgets } from "../scripts/budget.ts";

const BASELINE = fileURLToPath(new URL("../docs/prompt-budget.json", import.meta.url));
const ROOT = new URL("../", import.meta.url);
/** Room for ordinary wording changes, below which drift needs no decision. */
const TOLERANCE = 0.03;

test("--save --json writes the baseline and keeps stdout machine readable", async () => {
  const budgets = JSON.parse(await readFile(BASELINE, "utf8")) as Budgets;
  const directory = await mkdtemp(join(tmpdir(), "nekopi-budget-"));
  const baselinePath = join(directory, "baseline.json");
  const output: string[] = [];
  try {
    await runBudget(["--save", "--json"], {
      baselinePath,
      measure: async () => budgets,
      log: message => output.push(message),
    });
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual(budgets);
    expect(await readFile(baselinePath, "utf8")).toBe(`${JSON.stringify(budgets, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * The prompt and the tool schemas are sent with every request, so their size is
 * a fixed tax on every task. These tests make growth a decision rather than an
 * accident: when the surface legitimately changes, record it with
 * `bun run budget --save` in the same commit.
 *
 * Plain Pi is tracked beside it, because it is the baseline every claim here
 * is made against and a difference is only as good as the thing it is from.
 */
test("the prompt budget stays within tolerance of the committed baseline", async () => {
  const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as Budgets;
  const current = await measureAll();
  expect(baseline.tokenizerEncoding).toBe("o200k_base");
  for (const shape of SHAPES) {
    const before = baseline.shapes[shape], now = current.shapes[shape];
    expect(before, `the baseline has no ${shape} shape. Run 'bun run budget --save'.`).toBeDefined();
    expect(now.total,
      `The ${shape} shape now costs ${now.total} tokens a request, against a baseline of ${before.total}.`
      + " Run 'bun run budget' to see what grew, then 'bun run budget --save' if the growth is intended.",
    ).toBeLessThanOrEqual(Math.ceil(before.total * (1 + TOLERANCE)));

    // A tool added or removed changes what the agent can do, so it is never drift.
    expect(now.tools.items.map(item => item.name).sort(),
      `The ${shape} tool set changed. Run 'bun run budget --save' to record it.`,
    ).toEqual(before.tools.items.map(item => item.name).sort());
  }
}, 90_000);

test("the default shape is one tool and the baseline is plain Pi", async () => {
  const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as Budgets;
  expect(baseline.shapes.default.tools.items.map(item => item.name)).toEqual(["bash"]);
  // The prompt section is what replaces the schemas, so it has to be there.
  expect(baseline.shapes.default.systemPrompt.sections.map(section => section.name)).toContain("nekocli");
  // Plain Pi is measured against itself, so it claims none of the difference.
  expect(baseline.shapes.pi.systemPrompt.nekopi).toBe(0);
  expect(baseline.shapes.pi.systemPrompt.sections.every(section => section.nekopi === 0)).toBe(true);
});

test("the baseline records nekopi's own share, not Pi's", async () => {
  const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as Budgets;
  for (const shape of SHAPES) {
    const budget = baseline.shapes[shape];
    // Every section counts: absolute paths are normalized rather than excluded,
    // so the number means the same anywhere and nothing large hides behind one.
    expect(budget.systemPrompt.sections.map(section => section.name)).toContain("docs");
    expect(budget.systemPrompt.total).toBe(
      budget.systemPrompt.sections.reduce((sum, section) => sum + section.total, 0));
    expect(budget.systemPrompt.nekopi).toBe(
      budget.systemPrompt.sections.reduce((sum, section) => sum + section.nekopi, 0));
    expect(budget.total).toBe(budget.systemPrompt.total + budget.tools.total);
  }
  // nekopi replaces Pi's own documentation section with one line, so its signed
  // share of the system prompt comes out negative.
  expect(baseline.shapes.default.systemPrompt.nekopi).toBeLessThan(0);
});

/**
 * The documentation may not quote a per request figure the baseline disagrees
 * with.
 *
 * This is the cheapest defect in the repository to reintroduce and it was
 * present: the same quantity read 675 in `README.md` and `docs/tools.md` and
 * 694 in `docs/direction.md` and a bench record, and the true figure was
 * neither. Prose cannot be generated, so it is checked instead: any number
 * written beside "tokens a request" has to be one the baseline holds.
 */
describe("the documentation quotes the measured figures", () => {
  for (const file of ["README.md", "docs/configuration.md", "docs/tools.md", "docs/development.md"]) {
    test(file, async () => {
      const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as Budgets;
      const allowed = new Set(SHAPES.map(shape => baseline.shapes[shape].total));
      const text = await readFile(new URL(file, ROOT), "utf8");
      // The phrasings the documentation uses for a per request total. A new
      // one is not caught, so prefer "N tokens a request" when adding prose.
      // Scanning every line that mentions a request instead was tried and
      // reverted: it also caught component figures, such as a tool definition
      // costing 324 tokens, which is not a shape total.
      const rows = [...text.matchAll(/^\|\s*Sent every request\s*\|([^\n]*)\|/gmu)]
        .flatMap(row => [...row[1]!.matchAll(/([\d,]+)\s+tokens/gu)]);
      const columns = [...text.matchAll(/^(?:plain )?(?:pi|nekopi)[^\S\n]+([\d,]+)\s+tokens/gimu)];
      const quoted = [
        ...text.matchAll(/([\d,]+)\s+tokens (?:a|per) request/gu),
        ...text.matchAll(/(?:a |one )?request costs ([\d,]+)\s+tokens/gu),
        ...text.matchAll(/costing ([\d,]+)\s+tokens/gu),
        ...rows, ...columns,
      ].map(match => Number(match[1]!.replace(/,/gu, "")));
      for (const figure of quoted) {
        expect([...allowed],
          `${file} says "${figure} tokens a request", which no shape in docs/prompt-budget.json costs.`
          + " Run 'bun run budget' for the current figures.",
        ).toContain(figure);
      }
    });
  }
});
