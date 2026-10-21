import { describe, expect, it } from "vitest";
import { parseDialogTemplate } from "../src/parsers/pe/pe-dialog-template.js";

/** Build a minimal standard DLGTEMPLATE with the given controls. */
function buildTemplate(title: string, controls: Array<[string, string, number]>): Buffer {
  const parts: Buffer[] = [];
  const push = (b: Buffer) => parts.push(b);
  const u16 = (v: number) => push(Buffer.from([v & 0xff, (v >> 8) & 0xff]));
  const u32 = (v: number) => { u16(v & 0xffff); u16(v >>> 16); };

  // DLGTEMPLATE header
  u32(0x00c00080); // style
  u32(0); // exStyle
  u16(controls.length);
  for (const v of [0, 0, 200, 100]) u16(v & 0xffff); // x, y, cx, cy
  u16(0x0000); // menu: none
  u16(0xffff); u16(0x0082); // class: atom Static
  for (const ch of title) u16(ch.charCodeAt(0)); // title
  u16(0x0000);

  for (const [cls, text, id] of controls) {
    while ((parts.reduce((n, b) => n + b.length, 0) & 3) !== 0) u16(0); // align4
    u32(0x50000000); // style
    u32(0); // exStyle
    for (const v of [10, 10, 80, 14]) u16(v & 0xffff);
    u16(id);
    if (/^(Button|Edit|Static|ListBox|ScrollBar|ComboBox)$/.test(cls)) {
      const atoms: Record<string, number> = { Button: 0x80, Edit: 0x81, Static: 0x82, ListBox: 0x83, ScrollBar: 0x84, ComboBox: 0x85 };
      u16(0xffff); u16(atoms[cls]!);
    } else {
      for (const ch of cls) u16(ch.charCodeAt(0));
      u16(0x0000);
    }
    for (const ch of text) u16(ch.charCodeAt(0));
    u16(0x0000);
    u16(0); // extra data length
  }
  return Buffer.concat(parts);
}

describe("parseDialogTemplate", () => {
  it("decodes a standard DLGTEMPLATE with atom and string classes", () => {
    const buf = buildTemplate("About Box", [["Button", "OK", 1], ["SysLink", "visit", 7]]);
    const info = parseDialogTemplate(buf);
    expect(info).not.toBeNull();
    expect(info!.title).toBe("About Box");
    expect(info!.format).toBe("DLGTEMPLATE");
    expect(info!.controlCount).toBe(2);
    expect(info!.controls[0]).toEqual({ class: "Button", text: "OK", id: 1 });
    expect(info!.controls[1]!.class).toBe("SysLink");
  });

  it("returns null on truncated or non-dialog buffers", () => {
    expect(parseDialogTemplate(Buffer.alloc(4))).toBeNull();
    expect(parseDialogTemplate(Buffer.from("not a dialog template at all".repeat(2), "utf16le"))).toBeNull();
  });
});
