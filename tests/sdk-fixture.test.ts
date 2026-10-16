import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { createSdkFixture } from "./helpers/model-server.ts";

test.each(["sync", "async"] as const)("SDK fixture surfaces swallowed %s response failures after cleanup", async kind => {
  const fixture = await createSdkFixture();
  const failure = new Error("Synthetic response assertion failed.");
  fixture.setResponses([kind === "sync"
    ? () => { throw failure; }
    : async () => { await Promise.resolve(); throw failure; }]);
  await fixture.session.prompt("Trigger the response failure.");
  // Pi returns a model error instead of rejecting prompt(). The fixture must still fail its caller.
  const result = await fixture.cleanup().then(() => null, error => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.errors).toEqual([failure]);
  await expect(stat(fixture.root)).rejects.toMatchObject({ code: "ENOENT" });
});
