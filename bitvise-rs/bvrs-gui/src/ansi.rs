//! Minimal ANSI escape stripper for the terminal view.
//!
//! v1 renders line-oriented output; escape sequences (CSI, OSC, private
//! modes) are removed instead of interpreted. Sequences split across write
//! chunks are handled by stripping on flush boundaries.

/// Strip ANSI escape sequences from a byte stream and return printable text.
pub fn strip(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            0x1b => {
                // ESC
                i += 1;
                if i >= bytes.len() {
                    break;
                }
                match bytes[i] {
                    b'[' => {
                        // CSI: parameters until a final byte 0x40..=0x7e
                        i += 1;
                        while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                            i += 1;
                        }
                        i += 1; // final byte
                    }
                    b']' => {
                        // OSC: until BEL or ST (ESC \)
                        i += 1;
                        while i < bytes.len() && bytes[i] != 0x07 {
                            if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                                i += 1;
                                break;
                            }
                            i += 1;
                        }
                        i += 1;
                    }
                    _ => {
                        // Two-byte escapes (ESC X); drop the second byte.
                        i += 1;
                    }
                }
            }
            b'\n' | b'\r' | b'\t' => {
                out.push(b as char);
                i += 1;
            }
            c if c < 0x20 => {
                i += 1; // other C0 controls
            }
            _ => {
                // Copy one UTF-8 scalar (lossy on invalid sequences).
                let start = i;
                let len = utf8_len(bytes[i]);
                let end = (start + len).min(bytes.len());
                out.push_str(&String::from_utf8_lossy(&bytes[start..end]));
                i = end;
            }
        }
    }
    out
}

fn utf8_len(b: u8) -> usize {
    match b {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_csi_and_osc() {
        let raw = b"\x1b[2J\x1b[1;32mok\x1b[0m\n\x1b]0;title\x07plain\r\n";
        assert_eq!(strip(raw), "ok\nplain\r\n");
    }

    #[test]
    fn keeps_utf8_and_drops_controls() {
        assert_eq!(strip("héllo\n".as_bytes()), "héllo\n");
        assert_eq!(strip(b"a\x07b"), "ab");
    }

    #[test]
    fn two_byte_escape() {
        // ESC ( consumes the two-byte escape; the following bytes stay.
        assert_eq!(strip(b"A\x1b(B"), "AB");
        assert_eq!(strip(b"A\x1b(BB"), "ABB");
    }
}
