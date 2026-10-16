import { VERSION as PI_VERSION, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import manifest from "../package.json";

/** Standalone launcher only. Leave the host UI alone when loaded as a Pi package. */
export function createBrandingExtension(options: { verbose?: boolean } = {}): ExtensionFactory {
  return pi => {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode !== "tui" || (pi.getSettings().quietStartup === true && !options.verbose)) return;
      ctx.ui.setHeader((_tui, theme) => ({
        render(width: number): string[] {
          const name = "NekoPi";
          const versions = ` ${manifest.version} / Pi ${PI_VERSION}`;
          if (width < name.length + versions.length) {
            return [theme.fg("accent", name.slice(0, Math.max(0, width)))];
          }
          return [theme.fg("accent", name) + theme.fg("dim", versions)];
        },
        invalidate() {},
      }));
    });
  };
}
