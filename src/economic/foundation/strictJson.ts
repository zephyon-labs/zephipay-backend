export const MAX_ECONOMIC_JSON_BYTES = 32_768;

/** Bounded UTF-8 transport parser. Duplicate names (including escaped aliases) fail before JSON.parse. */
export function parseEconomicJson(raw: Uint8Array, maxBytes = MAX_ECONOMIC_JSON_BYTES): unknown {
  if (!(raw instanceof Uint8Array) || raw.byteLength > maxBytes) throw new Error("Invalid economic transport size.");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  let at = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(source[at] ?? "!") && at < source.length) at++; };
  const string = (): string => {
    const start = at++;
    while (at < source.length) {
      const char = source[at++];
      if (char === '"') return JSON.parse(source.slice(start, at)) as string;
      if (char === "\\") at++;
    }
    throw new Error("Unterminated JSON string.");
  };
  const value = (depth: number): void => {
    if (depth > 24) throw new Error("Economic JSON nesting limit.");
    whitespace();
    const char = source[at];
    if (char === '"') { string(); return; }
    if (char === "{" || char === "[") {
      at++;
      whitespace();
      const end = char === "{" ? "}" : "]", names = new Set<string>();
      if (source[at] === end) { at++; return; }
      for (;;) {
        whitespace();
        if (char === "{") {
          if (source[at] !== '"') throw new Error("Expected JSON member.");
          const name = string();
          if (names.has(name)) throw new Error("Duplicate economic JSON member.");
          names.add(name);
          whitespace();
          if (source[at++] !== ":") throw new Error("Expected JSON colon.");
        }
        value(depth + 1);
        whitespace();
        const delimiter = source[at++];
        if (delimiter === end) return;
        if (delimiter !== ",") throw new Error("Expected JSON delimiter.");
      }
    }
    const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at));
    if (!scalar) throw new Error("Invalid economic JSON value.");
    at += scalar[0].length;
  };
  value(0); whitespace();
  if (at !== source.length) throw new Error("Trailing economic JSON input.");
  return JSON.parse(source) as unknown;
}

export function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(record, key))) throw new Error("Unexpected or missing fields.");
  return record;
}
