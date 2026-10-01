import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEconomicJson } from "../src/economic/foundation/strictJson";

test("economic transport preserves ordinary JSON including nested arrays, escaped strings and prototype-named data", () => {
  for (const input of ['{"a":[1,true,null,{"x":"comma, colon: brace} and \\\""}]}', '{"__proto__":{"x":1},"constructor":0}', ' [false,-1.5e+2] ']) {
    assert.deepEqual(parseEconomicJson(Buffer.from(input)), JSON.parse(input));
  }
});
for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":0,"a":1}}', '[{"a":1,"a":1}]', '{"__proto__":0,"__proto__":1}']) {
  test(`reject duplicate economic members before parsing: ${input}`, () => assert.throws(() => parseEconomicJson(Buffer.from(input)), /Duplicate/));
}
for (const input of ['{"a":1,}', '[1,]', '{"a":}', '{"a":01}', '{}{}', 'true false', '"unterminated', '{"x":"bad\nline"}', '[Infinity]']) {
  test(`reject malformed raw economic JSON: ${JSON.stringify(input)}`, () => assert.throws(() => parseEconomicJson(Buffer.from(input))));
}
test("economic transport rejects invalid UTF-8, parsed objects, excessive bytes and excessive nesting", () => {
  assert.throws(() => parseEconomicJson(Buffer.from([0xff])));
  assert.throws(() => parseEconomicJson({ approved: true } as never));
  assert.throws(() => parseEconomicJson(Buffer.alloc(32_769)));
  assert.throws(() => parseEconomicJson(Buffer.from('['.repeat(26)+'0'+']'.repeat(26))));
});
