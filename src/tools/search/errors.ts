/** Quote bounded diagnostics without losing the failure reason after a long pattern. */
export function quotedSearchErrors(errors: readonly string[]): string {
  const message = errors.join("; "), quoted = JSON.stringify(message);
  const budget = 180;
  if (Buffer.byteLength(quoted) <= budget + 2) return quoted;
  const marker = "[... omitted ...]";
  function take(points: string[], maxBytes: number) {
    let text = "", bytes = 0;
    for (const point of points) {
      const size = Buffer.byteLength(JSON.stringify(point).slice(1, -1));
      if (bytes + size > maxBytes) break;
      text += point; bytes += size;
    }
    return text;
  }
  const points = Array.from(message);
  const head = take(points, 60);
  const tail = Array.from(take(points.reverse(), budget - 60 - Buffer.byteLength(marker))).reverse().join("");
  return JSON.stringify(head + marker + tail);
}
