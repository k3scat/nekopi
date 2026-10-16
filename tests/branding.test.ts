import { expect, test } from "bun:test";
import { VERSION as PI_VERSION, type ExtensionAPI, type ExtensionContext,
  type ExtensionUIContext, type SessionStartEvent, type Theme } from "@earendil-works/pi-coding-agent";
import manifest from "../package.json";
import { createBrandingExtension } from "../src/branding.ts";

type HeaderFactory = NonNullable<Parameters<ExtensionUIContext["setHeader"]>[0]>;
type Start = (event: SessionStartEvent, ctx: ExtensionContext) => void;

async function setup(mode: ExtensionContext["mode"], quietStartup: boolean | "header" = false, verbose = false) {
  let start!: Start;
  const headers: HeaderFactory[] = [];
  const pi = { on(event: string, handler: Start) {
    expect(event).toBe("session_start");
    start = handler;
  }, getSettings: () => ({ quietStartup }) } as unknown as ExtensionAPI;
  const ctx = { mode, ui: { setHeader: (factory: HeaderFactory) => headers.push(factory) } } as unknown as ExtensionContext;
  await createBrandingExtension({ verbose })(pi);
  start({ type: "session_start", reason: "startup" }, ctx);
  return { start, headers, ctx };
}

test("standalone header is a theme-aware single line with both package versions", async () => {
  const { headers } = await setup("tui");
  expect(headers).toHaveLength(1);
  const tokens: string[] = [];
  const theme = { fg: (token: string, text: string) => { tokens.push(token); return text; } } as unknown as Theme;
  const component = headers[0]!(undefined as never, theme);
  expect(component.render(80)).toEqual([`NekoPi ${manifest.version} / Pi ${PI_VERSION}`]);
  expect(tokens).toEqual(["accent", "dim"]);
  expect(() => component.invalidate()).not.toThrow();
});

test("header fits narrow terminals without slicing ANSI escapes", async () => {
  const { headers } = await setup("tui");
  const theme = { fg: (_token: string, text: string) => text } as unknown as Theme;
  const component = headers[0]!(undefined as never, theme);
  for (let width = 0; width < 80; width++) {
    const lines = component.render(width);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(width);
  }
  expect(component.render(6)).toEqual(["NekoPi"]);
});

test("quietStartup and non-TUI modes keep the host UI untouched", async () => {
  expect((await setup("tui", true)).headers).toEqual([]);
  expect((await setup("tui", "header")).headers).toHaveLength(1);
  expect((await setup("tui", true, true)).headers).toHaveLength(1);
  for (const mode of ["print", "json", "rpc"] as const) expect((await setup(mode)).headers).toEqual([]);
});

test("header is reinstalled through the normal reload lifecycle", async () => {
  const { headers, start, ctx } = await setup("tui");
  start({ type: "session_start", reason: "reload" }, ctx);
  expect(headers).toHaveLength(2);
});
