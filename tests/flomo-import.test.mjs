import assert from "node:assert/strict";
import test from "node:test";

import { extractFlomoMemosFromText } from "../flomo-import.mjs";

test("extractFlomoMemosFromText reads JSON exports", () => {
  const memos = extractFlomoMemosFromText(JSON.stringify([
    { id: "1", content: "First memo #PAI", created_at: "2026-05-15 10:30:00" },
    { id: "2", content: "<p>Second memo</p>", created_at: "2026-05-15 11:00:00" },
  ]));

  assert.equal(memos.length, 2);
  assert.equal(memos[0].content, "First memo #PAI");
  assert.deepEqual(memos[0].tags, ["PAI"]);
  assert.equal(memos[1].content, "Second memo");
});

test("extractFlomoMemosFromText has a plain HTML fallback", () => {
  const memos = extractFlomoMemosFromText(`
    <html><body>
    2026-05-15 10:30<br>First exported memo #flomo
    2026-05-15 11:00<br>Second exported memo
    </body></html>
  `);

  assert.equal(memos.length, 2);
  assert.match(memos[0].content, /First exported memo/);
});
