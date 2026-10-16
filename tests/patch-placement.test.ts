/**
 * The cases that made `patch` the most expensive command in the harness.
 *
 * Each test here is a shape taken from the 2026-10-11 wide tier streams, where
 * `patch` failed 58.6 percent of its calls. These cases pin how the engine
 * handles a hunk when its placement would be a guess.
 */
import { describe as group, expect, test } from "bun:test";
import { describe, lineAt, occurrencesOf, placeAnyEnding, placeHunks, splice } from "../src/tools/patch/placement.ts";

/** The shape 96 of 111 recorded failures had: a unique anchor, then a brace. */
const GO = `package shared

func ColorForPRState(pr api.PullRequest) string {
	switch pr.State {
	case "OPEN":
		return "green"
	}
	return "gray"
}

func Other() string {
	return "x"
}
`;

group("placing a hunk the dialect gives no line number", () => {
  test("a brace after a unique anchor goes to that function's brace, not the first one", () => {
    // The old checker counted 6 occurrences of "}" by substring, including the
    // ones inside "\t}" and the two later functions, and refused the pair.
    const { placed, unplaced } = placeHunks(GO, [
      { oldText: 'func ColorForPRState(pr api.PullRequest) string {', newText: 'func ColorForPRState(pr api.PullRequest) string {' },
      { oldText: '}', newText: '}\n\nfunc Added() {}' },
    ]);
    expect(unplaced).toEqual([]);
    expect(placed).toBeDefined();
    // Line 9 is the brace closing ColorForPRState. Line 7 is the switch's
    // brace, which is indented and so is not a whole-line match for "}".
    expect(placed!.map(one => one.line)).toEqual([3, 9]);
    expect(splice(GO, placed!)).toContain('	return "gray"\n}\n\nfunc Added() {}');
    // The function that follows is untouched, which is the thing a wrong brace
    // would have destroyed.
    expect(splice(GO, placed!)).toContain('func Other() string {\n	return "x"\n}\n');
  });

  test("a whole-line match is preferred over a match inside a line", () => {
    // "}" occurs inside "\t}" too. A diff hunk is whole lines, so only the
    // unindented braces are candidates.
    const lines = occurrencesOf(GO, '}').map(at => lineAt(GO, at));
    expect(lines).toEqual([9, 13]);
  });

  test("a hunk whose leading whitespace was dropped still matches", () => {
    // Line alignment must not regress this: the model writes `return "x"`
    // where the file has a tab in front of it, and that used to apply.
    const found = occurrencesOf(GO, 'return "x"');
    expect(found.length).toBe(1);
  });

  test("the only hunk in a file, not unique, is refused with both its lines", () => {
    const source = "a\nx\nb\nx\nc\n";
    const { placed, unplaced } = placeHunks(source, [{ oldText: "x", newText: "y" }]);
    expect(placed).toBeUndefined();
    expect(unplaced[0]!.reason).toBe("ambiguous");
    expect(unplaced[0]!.lines).toEqual([2, 4]);
    const said = describe("f.txt", unplaced);
    expect(said[0]).toContain("appears 2 times, at line 2, 4");
    // The message has to teach the way out, or it costs the same round trip.
    expect(said[0]).toContain('"@@ 2"');
  });

  test("a line number in the hunk header picks the occurrence the model meant", () => {
    const source = "a\nx\nb\nx\nc\n";
    const { placed, unplaced } = placeHunks(source, [{ oldText: "x", newText: "y", atLine: 4 }]);
    expect(unplaced).toEqual([]);
    expect(placed!.map(one => one.line)).toEqual([4]);
    expect(splice(source, placed!)).toBe("a\nx\nb\ny\nc\n");
  });

  test("a real unified header's line number is read the same way", () => {
    const source = "a\nx\nb\nx\nc\n";
    // `@@ -4,1 +4,1 @@` parses to 4 in nekocli; here the value is what matters.
    const { placed } = placeHunks(source, [{ oldText: "x", newText: "y", atLine: 4 }]);
    expect(placed!.map(one => one.line)).toEqual([4]);
  });

  test("disjoint certain hunks apply even when listed in reverse source order", () => {
    const source = "tail\nhead\n";
    const { placed, unplaced } = placeHunks(source, [
      { oldText: "head", newText: "HEAD" },
      { oldText: "tail", newText: "TAIL" },
    ]);
    expect(unplaced).toEqual([]);
    expect(placed!.map(one => one.line)).toEqual([1, 2]);
    expect(splice(source, placed!)).toBe("TAIL\nHEAD\n");
  });

  test("a numbered ambiguous match can join a disjoint reverse-order patch", () => {
    const source = "x\nother\nx\nhead\n";
    const { placed, unplaced } = placeHunks(source, [
      { oldText: "head", newText: "HEAD" },
      { oldText: "x", newText: "X", atLine: 3 },
    ]);
    expect(unplaced).toEqual([]);
    expect(splice(source, placed!)).toBe("x\nother\nX\nHEAD\n");
  });

  test("overlapping certain hunks are refused", () => {
    const source = "first\nsecond\nthird\n";
    const { placed, unplaced } = placeHunks(source, [
      { oldText: "second\nthird", newText: "LAST" },
      { oldText: "first\nsecond", newText: "FIRST" },
    ]);
    expect(placed).toBeUndefined();
    expect(unplaced[0]!.reason).toBe("crowded");
    expect(unplaced[0]!.index).toBe(0);
  });

  test("certain hunks in source order keep their usual placement", () => {
    const source = "first\nsecond\nthird\n";
    const { placed, unplaced } = placeHunks(source, [
      { oldText: "first", newText: "FIRST" },
      { oldText: "third", newText: "THIRD" },
    ]);
    expect(unplaced).toEqual([]);
    expect(placed!.map(one => one.line)).toEqual([1, 3]);
    expect(splice(source, placed!)).toBe("FIRST\nsecond\nTHIRD\n");
  });

  test("a hunk whose text is absent is told where its lines stop matching", () => {
    const source = "one\ntwo\nthree\n";
    const { unplaced } = placeHunks(source, [{ oldText: "one\ntwo\nNOPE", newText: "x" }]);
    expect(unplaced[0]!.reason).toBe("missing");
    expect(unplaced[0]!.near).toEqual({ line: 1, matched: 2, of: 3 });
    expect(describe("f.txt", unplaced)[0]).toContain("first 2 of 3 lines match at line 1");
  });

  test("every unplaceable hunk is reported, not only the first", () => {
    // The old checker returned at the first failure, so a model fixing a
    // four hunk envelope paid one round trip per bad hunk.
    const source = "anchor\nx\nmid\nx\ny\nz\ny\n";
    const { unplaced } = placeHunks(source, [
      { oldText: "anchor", newText: "anchor" },
      { oldText: "ABSENT", newText: "a" },
      { oldText: "MISSING", newText: "b" },
    ]);
    expect(unplaced.map(one => one.index)).toEqual([1, 2]);
    expect(describe("f.txt", unplaced)).toHaveLength(2);
  });

  test("a hunk with no context at all is named as such", () => {
    const { unplaced } = placeHunks("a\n", [
      { oldText: "a", newText: "a" },
      { oldText: "", newText: "added" },
    ]);
    expect(unplaced[0]!.reason).toBe("empty");
    expect(describe("f.txt", unplaced)[0]).toContain("no context to match");
  });

  test("two identical hunks are refused, because both claim the same bytes", () => {
    // A model that duplicates a hunk must not get it applied twice.
    const source = "a\nTARGET\nb\n";
    const { placed, unplaced } = placeHunks(source, [
      { oldText: "TARGET", newText: "ONE" },
      { oldText: "TARGET", newText: "TWO" },
    ]);
    expect(placed).toBeUndefined();
    expect(unplaced[0]!.reason).toBe("crowded");
  });

  test("an anchor past the end of the file falls back to the unique occurrence", () => {
    const source = "a\nTARGET\nb\n";
    const { placed } = placeHunks(source, [{ oldText: "TARGET", newText: "X", atLine: 9999 }]);
    expect(placed!.map(one => one.line)).toEqual([2]);
  });

  test("an empty file reports the text as absent rather than throwing", () => {
    const { placed, unplaced } = placeHunks("", [{ oldText: "x", newText: "y" }]);
    expect(placed).toBeUndefined();
    expect(unplaced[0]!.reason).toBe("missing");
  });

  test("a CRLF file places a single line hunk, and a multi-line one on the second pass", () => {
    // The envelope parser normalizes its own text to LF while the source is
    // read as it is, so on a CRLF file every joining newline of a multi-line
    // hunk is wrong. A second pass converts the hunk rather than the file.
    const source = "a\r\nTARGET\r\nb\r\n";
    const { placed } = placeHunks(source, [{ oldText: "TARGET", newText: "X" }]);
    expect(placed!.map(one => one.line)).toEqual([2]);
    expect(splice(source, placed!)).toBe("a\r\nX\r\nb\r\n");
    const multi = placeAnyEnding(source, [{ oldText: "TARGET\nb", newText: "X\nY" }]);
    expect(multi.unplaced).toEqual([]);
    expect(splice(source, multi.placed!)).toBe("a\r\nX\r\nY\r\n");
  });

  test("an LF file is untouched by the second pass, and a failure still reports once", () => {
    const source = "a\nb\nc\n";
    const { placed } = placeAnyEnding(source, [{ oldText: "b\nc", newText: "B\nC" }]);
    expect(splice(source, placed!)).toBe("a\nB\nC\n");
    const absent = placeAnyEnding("a\r\nb\r\n", [{ oldText: "zzz", newText: "q" }]);
    expect(absent.unplaced).toHaveLength(1);
    expect(absent.unplaced[0]!.reason).toBe("missing");
  });

  test("splicing several hunks of one file keeps every byte between them", () => {
    const source = "1\n2\n3\n4\n5\n";
    const { placed } = placeHunks(source, [
      { oldText: "2", newText: "TWO" },
      { oldText: "4", newText: "FOUR" },
    ]);
    expect(splice(source, placed!)).toBe("1\nTWO\n3\nFOUR\n5\n");
  });
});
