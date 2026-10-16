import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { compactRepeatedVitestFailures } from "./compact-vitest.ts";
import { discoveryFeedback } from "./discovery.ts";
import { verificationFeedback } from "./verification.ts";

/** Apply result notes without hiding a note when a long preview is folded. */
export async function nativeBashFeedback(event: ToolResultEvent, cwd: string):
Promise<ToolResultEventResult | undefined> {
  const verification = verificationFeedback(event);
  if (verification?.content) return verification;
  // Metadata-only verification must not displace discovery notes from the same chain.
  const discovery = await discoveryFeedback(event, cwd);
  const compacted = compactRepeatedVitestFailures(event);
  if (compacted) {
    return { ...verification, ...compacted, content: [
      ...(compacted.content ?? []), ...(discovery?.content?.slice(event.content.length) ?? []),
    ] };
  }
  return discovery ? { ...verification, ...discovery } : verification;
}
