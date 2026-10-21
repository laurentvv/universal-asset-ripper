/**
 * Win32 dialog template parser (RT_DIALOG resources).
 *
 * Decodes DLGTEMPLATE and DLGTEMPLATEEX (DLGTEMPLATEEX starts with the
 * 0xFFFF signature) into a readable JSON structure: dialog title plus one
 * entry per control with its window class and caption. Used to inventory
 * the windows embedded in native PE applications (clean-room reimplementation
 * workflow — see docs/workflow-clean-room-reimplementation.md).
 */

/** Standard control class atoms (winuser.h). */
const CLASS_ATOMS: Record<number, string> = {
  0x0080: "Button",
  0x0081: "Edit",
  0x0082: "Static",
  0x0083: "ListBox",
  0x0084: "ScrollBar",
  0x0085: "ComboBox",
};

export interface DialogControl {
  class: string;
  text: string;
  id: number;
}

export interface DialogInfo {
  format: "DLGTEMPLATE" | "DLGTEMPLATEEX";
  title: string;
  menu: string | null;
  style: number;
  controlCount: number;
  controls: DialogControl[];
}

class Cursor {
  offset = 0;
  constructor(private readonly buf: Buffer) {}

  need(bytes: number): void {
    if (this.offset + bytes > this.buf.length) {
      throw new RangeError(`dialog template truncated at ${this.offset}`);
    }
  }

  align4(): void {
    this.offset = (this.offset + 3) & ~3;
  }

  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  i16(): number {
    return this.u16() | 0;
  }

  peek16(): number {
    this.need(2);
    return this.buf.readUInt16LE(this.offset);
  }

  /** sz_Or_Ord: 0x0000 = absent, 0xFFFF + atom = predefined, else UTF-16z. */
  szOrOrd(): string | null {
    const first = this.u16();
    if (first === 0x0000) return null;
    if (first === 0xffff) {
      const atom = this.u16();
      return CLASS_ATOMS[atom] ?? `atom:0x${atom.toString(16)}`;
    }
    let out = String.fromCharCode(first);
    for (;;) {
      const c = this.u16();
      if (c === 0x0000) break;
      out += String.fromCharCode(c);
    }
    return out;
  }
}

/** Parse one RT_DIALOG buffer; returns null when it is not a dialog template. */
export function parseDialogTemplate(buf: Buffer): DialogInfo | null {
  if (buf.length < 26) return null;
  const c = new Cursor(buf);
  try {
    // Compiled .res DIALOGEX resources start with version=1 followed by the
    // 0xFFFF signature (word-swapped relative to the MSDN struct listing).
    const isEx =
      buf.length >= 4 && buf.readUInt16LE(0) === 0x0001 && buf.readUInt16LE(2) === 0xffff;
    if (isEx) {
      c.u16(); // version
      c.u16(); // signature
    }
    let style: number;
    let controlCount: number;
    if (isEx) {
      c.u32(); // helpID
      c.u32(); // exStyle
      style = c.u32();
      controlCount = c.u16();
      c.i16();
      c.i16();
      c.i16();
      c.i16();
    } else {
      style = c.u32();
      c.u32(); // exStyle
      controlCount = c.u16();
      c.i16();
      c.i16();
      c.i16();
      c.i16();
    }
    const menu = c.szOrOrd();
    c.szOrOrd(); // dialog window class
    const title = c.szOrOrd() ?? "";

    const controls: DialogControl[] = [];
    for (let i = 0; i < controlCount; i++) {
      c.align4();
      let id: number;
      if (isEx) {
        c.u32(); // helpID
        c.u32(); // exStyle
        c.u32(); // style
        c.i16();
        c.i16();
        c.i16();
        c.i16();
        id = c.u32();
      } else {
        c.u32(); // style
        c.u32(); // exStyle
        c.i16();
        c.i16();
        c.i16();
        c.i16();
        id = c.u16();
      }
      const cls = c.szOrOrd() ?? "";
      const text = c.szOrOrd() ?? "";
      const extra = c.u16();
      c.need(extra);
      c.offset += extra;
      controls.push({ class: cls, text, id });
    }

    return {
      format: isEx ? "DLGTEMPLATEEX" : "DLGTEMPLATE",
      title,
      menu,
      style,
      controlCount,
      controls,
    };
  } catch {
    return null;
  }
}
