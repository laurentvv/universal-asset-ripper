/**
 * Converts Delphi / C++Builder binary forms (TPF0 streams, RT_RCDATA) to the readable
 * text DFM syntax. Best effort: returns null on any malformed or unsupported input, never throws.
 */

const VA = {
  Null: 0,
  List: 1,
  Int8: 2,
  Int16: 3,
  Int32: 4,
  Extended: 5,
  String: 6,
  Ident: 7,
  False: 8,
  True: 9,
  Binary: 10,
  Set: 11,
  LString: 12,
  Nil: 13,
  Collection: 14,
  Single: 15,
  Currency: 16,
  Date: 17,
  WString: 18,
  Int64: 19,
  UTF8String: 20,
  Double: 21
} as const;

const MAX_DEPTH = 64;
const MAX_NODES = 200000;

class DfmReader {
  pos = 0;
  nodes = 0;

  constructor(readonly buf: Buffer) {}

  need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error("DFM: unexpected end of data");
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }

  peek(): number {
    this.need(1);
    return this.buf[this.pos];
  }

  bytes(n: number): Buffer {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  shortString(): string {
    const len = this.u8();
    return this.bytes(len).toString("latin1");
  }
}

/** Delphi string literal: printable ASCII in quotes, everything else as #code */
function quote(text: string): string {
  if (text.length === 0) return "''";
  let out = "";
  let inQuote = false;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 32 && code <= 126) {
      if (!inQuote) {
        out += "'";
        inQuote = true;
      }
      out += ch === "'" ? "''" : ch;
    } else {
      if (inQuote) {
        out += "'";
        inQuote = false;
      }
      out += `#${code}`;
    }
  }
  if (inQuote) out += "'";
  return out;
}

function formatFloat(v: number, suffix = ""): string {
  if (!Number.isFinite(v)) return "0" + suffix;
  const s = Number(v.toPrecision(15)).toString();
  return s + suffix;
}

/** 80-bit x87 extended to a JS double (loses precision, fine for display) */
function readExtended(b: Buffer): number {
  const mantissa = b.readBigUInt64LE(0);
  const se = b.readUInt16LE(8);
  const sign = se & 0x8000 ? -1 : 1;
  const exp = se & 0x7fff;
  if (exp === 0 && mantissa === 0n) return 0;
  if (exp === 0x7fff) return NaN;
  return sign * Number(mantissa) * Math.pow(2, exp - 16383 - 63);
}

function readIntValue(r: DfmReader, type: number): number {
  switch (type) {
    case VA.Int8:
      r.need(1);
      return r.buf.readInt8(r.pos++);
    case VA.Int16: {
      r.need(2);
      const v = r.buf.readInt16LE(r.pos);
      r.pos += 2;
      return v;
    }
    case VA.Int32: {
      r.need(4);
      const v = r.buf.readInt32LE(r.pos);
      r.pos += 4;
      return v;
    }
    default:
      throw new Error(`DFM: expected integer, got value type ${type}`);
  }
}

function readValue(r: DfmReader, indent: number, depth: number): string {
  if (depth > MAX_DEPTH) throw new Error("DFM: nesting too deep");
  const pad = "  ".repeat(indent);
  const type = r.u8();

  switch (type) {
    case VA.Null:
      return "Null";
    case VA.Int8:
    case VA.Int16:
    case VA.Int32:
      return String(readIntValue(r, type));
    case VA.Int64: {
      r.need(8);
      const v = r.buf.readBigInt64LE(r.pos);
      r.pos += 8;
      return v.toString();
    }
    case VA.Extended:
      return formatFloat(readExtended(r.bytes(10)));
    case VA.Single: {
      const b = r.bytes(4);
      return formatFloat(b.readFloatLE(0), "s");
    }
    case VA.Double:
    case VA.Date: {
      const b = r.bytes(8);
      return formatFloat(b.readDoubleLE(0), type === VA.Date ? "d" : "");
    }
    case VA.Currency: {
      const b = r.bytes(8);
      return (Number(b.readBigInt64LE(0)) / 10000).toFixed(4) + "c";
    }
    case VA.String:
      return quote(r.bytes(r.u8()).toString("latin1"));
    case VA.LString:
      return quote(r.bytes(r.u32()).toString("latin1"));
    case VA.UTF8String:
      return quote(r.bytes(r.u32()).toString("utf8"));
    case VA.WString: {
      const len = r.u32();
      return quote(r.bytes(len * 2).toString("utf16le"));
    }
    case VA.Ident:
      return r.bytes(r.u8()).toString("latin1");
    case VA.False:
      return "False";
    case VA.True:
      return "True";
    case VA.Nil:
      return "nil";
    case VA.Set: {
      const items: string[] = [];
      for (;;) {
        const s = r.shortString();
        if (s.length === 0) break;
        items.push(s);
      }
      return `[${items.join(", ")}]`;
    }
    case VA.Binary: {
      const data = r.bytes(r.u32());
      if (data.length === 0) return "{}";
      const lines: string[] = [];
      for (let i = 0; i < data.length; i += 32) {
        lines.push(pad + "  " + data.subarray(i, i + 32).toString("hex").toUpperCase());
      }
      return `{\n${lines.join("\n")}}`;
    }
    case VA.List: {
      const items: string[] = [];
      while (r.peek() !== VA.Null) {
        r.nodes++;
        if (r.nodes > MAX_NODES) throw new Error("DFM: too many values");
        items.push(pad + "  " + readValue(r, indent + 1, depth + 1));
      }
      r.u8(); // list end
      return items.length === 0 ? "()" : `(\n${items.join("\n")})`;
    }
    case VA.Collection: {
      const items: string[] = [];
      while (r.peek() !== VA.Null) {
        if (r.peek() === VA.Int8 || r.peek() === VA.Int16 || r.peek() === VA.Int32) {
          readIntValue(r, r.u8()); // item order index
        }
        if (r.u8() !== VA.List) throw new Error("DFM: malformed collection item");
        const lines: string[] = [`${pad}  item`];
        while (r.peek() !== VA.Null) {
          lines.push(readProperty(r, indent + 2, depth + 1));
        }
        r.u8(); // property list end
        lines.push(`${pad}  end`);
        items.push(lines.join("\n"));
      }
      r.u8(); // collection end
      return items.length === 0 ? "<>" : `<\n${items.join("\n")}>`;
    }
    default:
      throw new Error(`DFM: unsupported value type ${type}`);
  }
}

function readProperty(r: DfmReader, indent: number, depth: number): string {
  r.nodes++;
  if (r.nodes > MAX_NODES) throw new Error("DFM: too many properties");
  const name = r.shortString();
  if (name.length === 0) throw new Error("DFM: empty property name");
  return `${"  ".repeat(indent)}${name} = ${readValue(r, indent, depth + 1)}`;
}

function readObject(r: DfmReader, indent: number, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) throw new Error("DFM: nesting too deep");
  r.nodes++;
  if (r.nodes > MAX_NODES) throw new Error("DFM: too many objects");

  let keyword = "object";
  let childPos: number | null = null;
  if ((r.peek() & 0xf0) === 0xf0) {
    const flags = r.u8() & 0x0f;
    if (flags & 1) keyword = "inherited";
    else if (flags & 4) keyword = "inline";
    if (flags & 2) childPos = readIntValue(r, r.u8());
  }

  const className = r.shortString();
  const objectName = r.shortString();
  const pad = "  ".repeat(indent);
  const head = objectName.length > 0 ? `${objectName}: ${className}` : className;
  out.push(`${pad}${keyword} ${head}${childPos !== null ? ` [${childPos}]` : ""}`);

  while (r.peek() !== 0) {
    out.push(readProperty(r, indent + 1, depth));
  }
  r.u8(); // end of properties

  while (r.peek() !== 0) {
    readObject(r, indent + 1, depth + 1, out);
  }
  r.u8(); // end of children
  out.push(`${pad}end`);
}

/** True when the buffer starts with the binary form signature "TPF0" */
export function isBinaryDfm(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x30465054;
}

/**
 * Convert a binary TPF0 form stream to text DFM. Returns null when the data is not a valid
 * form or contains a value type this converter does not know.
 */
export function convertBinaryDfmToText(buf: Buffer): string | null {
  if (!isBinaryDfm(buf)) return null;
  try {
    const r = new DfmReader(buf);
    r.pos = 4;
    const out: string[] = [];
    readObject(r, 0, 0, out);
    return out.join("\n") + "\n";
  } catch {
    return null;
  }
}
