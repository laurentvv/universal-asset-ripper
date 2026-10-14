//! Reader for binary Delphi forms (`TPF0` streams, `RT_RCDATA`), a Rust mirror of
//! `src/parsers/delphi/dfm-converter.ts` in the repository root, plus the few "form specs"
//! (main window, toolbar, menus, status bar, About box) the UI is driven by.

use std::collections::HashMap;
use std::sync::OnceLock;

const MAX_DEPTH: usize = 64;
const MAX_NODES: usize = 200_000;

static MAIN_FORM: &[u8] = include_bytes!("../assets/rcdata/form_TMAINFORM.dfm");
static ABOUT_FORM: &[u8] = include_bytes!("../assets/rcdata/form_TJAMABOUTFORM.dfm");
static VERSION_RES: &[u8] = include_bytes!("../assets/rt_version/res_1");

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Int(i64),
    Float(f64),
    Str(String),
    Ident(String),
    Bool(bool),
    Set(Vec<String>),
    /// Length only: the payload (image lists, fonts...) is not needed by the clone.
    Binary(usize),
    List(Vec<Value>),
    Collection(Vec<Vec<(String, Value)>>),
    Nil,
}

#[derive(Debug, Clone, Default)]
pub struct Object {
    pub class: String,
    pub name: String,
    pub props: Vec<(String, Value)>,
    pub children: Vec<Object>,
}

impl Object {
    pub fn prop(&self, name: &str) -> Option<&Value> {
        self.props.iter().find(|(k, _)| k == name).map(|(_, v)| v)
    }

    pub fn str_prop(&self, name: &str) -> Option<&str> {
        match self.prop(name)? {
            Value::Str(s) | Value::Ident(s) => Some(s),
            _ => None,
        }
    }

    pub fn int_prop(&self, name: &str) -> Option<i64> {
        match self.prop(name)? {
            Value::Int(i) => Some(*i),
            _ => None,
        }
    }

    /// Depth-first search by component name (including `self`).
    pub fn find(&self, name: &str) -> Option<&Object> {
        if self.name == name {
            return Some(self);
        }
        self.children.iter().find_map(|c| c.find(name))
    }

    /// Number of objects in the subtree (including `self`).
    #[cfg(test)]
    pub fn count(&self) -> usize {
        1 + self.children.iter().map(Object::count).sum::<usize>()
    }
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    nodes: usize,
}

type R<T> = Result<T, String>;

impl<'a> Reader<'a> {
    fn need(&self, n: usize) -> R<()> {
        if self.pos.checked_add(n).is_none_or(|e| e > self.buf.len()) {
            Err("DFM: unexpected end of data".into())
        } else {
            Ok(())
        }
    }
    fn u8(&mut self) -> R<u8> {
        self.need(1)?;
        self.pos += 1;
        Ok(self.buf[self.pos - 1])
    }
    fn peek(&self) -> R<u8> {
        self.need(1)?;
        Ok(self.buf[self.pos])
    }
    fn bytes(&mut self, n: usize) -> R<&'a [u8]> {
        self.need(n)?;
        self.pos += n;
        Ok(&self.buf[self.pos - n..self.pos])
    }
    fn u32(&mut self) -> R<u32> {
        let b = self.bytes(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn short_string(&mut self) -> R<String> {
        let n = self.u8()? as usize;
        Ok(latin1(self.bytes(n)?))
    }
    fn tick(&mut self) -> R<()> {
        self.nodes += 1;
        if self.nodes > MAX_NODES {
            Err("DFM: too many nodes".into())
        } else {
            Ok(())
        }
    }
}

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

/// 80-bit x87 extended to f64 (precision loss is fine for layout numbers).
fn extended(b: &[u8]) -> f64 {
    let mant = u64::from_le_bytes(b[..8].try_into().unwrap_or([0; 8]));
    let se = u16::from_le_bytes([b[8], b[9]]);
    let sign = if se & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = (se & 0x7fff) as i32;
    if exp == 0 && mant == 0 {
        return 0.0;
    }
    if exp == 0x7fff {
        return f64::NAN;
    }
    sign * mant as f64 * 2f64.powi(exp - 16383 - 63)
}

fn int_of(r: &mut Reader, ty: u8) -> R<i64> {
    Ok(match ty {
        2 => r.bytes(1)?[0] as i8 as i64,
        3 => {
            let b = r.bytes(2)?;
            i16::from_le_bytes([b[0], b[1]]) as i64
        }
        4 => {
            let b = r.bytes(4)?;
            i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as i64
        }
        t => return Err(format!("DFM: expected integer, got value type {t}")),
    })
}

fn read_value(r: &mut Reader, depth: usize) -> R<Value> {
    if depth > MAX_DEPTH {
        return Err("DFM: nesting too deep".into());
    }
    let ty = r.u8()?;
    Ok(match ty {
        0 => Value::Null,
        2..=4 => Value::Int(int_of(r, ty)?),
        19 => {
            let b = r.bytes(8)?;
            Value::Int(i64::from_le_bytes(b.try_into().map_err(|_| "i64")?))
        }
        5 => Value::Float(extended(r.bytes(10)?)),
        15 => {
            let b = r.bytes(4)?;
            Value::Float(f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64)
        }
        17 | 21 => {
            let b = r.bytes(8)?;
            Value::Float(f64::from_le_bytes(b.try_into().map_err(|_| "f64")?))
        }
        16 => {
            let b = r.bytes(8)?;
            Value::Float(i64::from_le_bytes(b.try_into().map_err(|_| "cur")?) as f64 / 10000.0)
        }
        6 => {
            let n = r.u8()? as usize;
            Value::Str(latin1(r.bytes(n)?))
        }
        12 => {
            let n = r.u32()? as usize;
            Value::Str(latin1(r.bytes(n)?))
        }
        20 => {
            let n = r.u32()? as usize;
            Value::Str(String::from_utf8_lossy(r.bytes(n)?).into_owned())
        }
        18 => {
            let n = r.u32()? as usize;
            let b = r.bytes(n.checked_mul(2).ok_or("DFM: overflow")?)?;
            let u: Vec<u16> = b.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
            Value::Str(String::from_utf16_lossy(&u))
        }
        7 => {
            let n = r.u8()? as usize;
            Value::Ident(latin1(r.bytes(n)?))
        }
        8 => Value::Bool(false),
        9 => Value::Bool(true),
        13 => Value::Nil,
        11 => {
            let mut items = Vec::new();
            loop {
                let s = r.short_string()?;
                if s.is_empty() {
                    break;
                }
                items.push(s);
            }
            Value::Set(items)
        }
        10 => {
            let n = r.u32()? as usize;
            r.bytes(n)?;
            Value::Binary(n)
        }
        1 => {
            let mut items = Vec::new();
            while r.peek()? != 0 {
                r.tick()?;
                items.push(read_value(r, depth + 1)?);
            }
            r.u8()?;
            Value::List(items)
        }
        14 => {
            let mut items = Vec::new();
            while r.peek()? != 0 {
                if matches!(r.peek()?, 2..=4) {
                    let t = r.u8()?;
                    int_of(r, t)?;
                }
                if r.u8()? != 1 {
                    return Err("DFM: malformed collection item".into());
                }
                let mut props = Vec::new();
                while r.peek()? != 0 {
                    props.push(read_property(r, depth + 1)?);
                }
                r.u8()?;
                items.push(props);
            }
            r.u8()?;
            Value::Collection(items)
        }
        t => return Err(format!("DFM: unsupported value type {t}")),
    })
}

fn read_property(r: &mut Reader, depth: usize) -> R<(String, Value)> {
    r.tick()?;
    let name = r.short_string()?;
    if name.is_empty() {
        return Err("DFM: empty property name".into());
    }
    Ok((name, read_value(r, depth + 1)?))
}

fn read_object(r: &mut Reader, depth: usize) -> R<Object> {
    if depth > MAX_DEPTH {
        return Err("DFM: nesting too deep".into());
    }
    r.tick()?;
    if r.peek()? & 0xf0 == 0xf0 {
        let flags = r.u8()? & 0x0f;
        if flags & 2 != 0 {
            let t = r.u8()?;
            int_of(r, t)?;
        }
    }
    let mut o = Object { class: r.short_string()?, name: r.short_string()?, ..Default::default() };
    while r.peek()? != 0 {
        o.props.push(read_property(r, depth)?);
    }
    r.u8()?;
    while r.peek()? != 0 {
        o.children.push(read_object(r, depth + 1)?);
    }
    r.u8()?;
    Ok(o)
}

/// Parse a binary form stream (`TPF0...`) into an object tree.
pub fn parse(buf: &[u8]) -> Result<Object, String> {
    if buf.len() < 4 || &buf[..4] != b"TPF0" {
        return Err("not a binary DFM (missing TPF0 signature)".into());
    }
    let mut r = Reader { buf, pos: 4, nodes: 0 };
    read_object(&mut r, 0)
}

// ---------------------------------------------------------------------------------------------
// Form specs
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct ActionInfo {
    pub caption: String,
    pub hint: String,
    /// Delphi `TShortCut` (modifier bits | virtual key); 0 when none.
    pub shortcut: i64,
}

#[derive(Debug, Clone, Default)]
pub struct Item {
    pub name: String,
    pub action: Option<String>,
    pub caption: String,
    pub hint: String,
    pub separator: bool,
    pub children: Vec<Item>,
}

#[derive(Debug, Clone)]
pub struct MainFormSpec {
    pub caption: String,
    pub client_w: f32,
    pub client_h: f32,
    pub min_w: f32,
    pub min_h: f32,
    pub toolbar: Vec<Item>,
    pub menu: Vec<Item>,
    /// Widths of the status bar panels.
    pub status_panels: Vec<f32>,
    pub actions: HashMap<String, ActionInfo>,
}

impl Default for MainFormSpec {
    /// Fallback layout used when the embedded DFM cannot be parsed.
    fn default() -> Self {
        Self {
            caption: "TreeSize Free".into(),
            client_w: 1100.0,
            client_h: 700.0,
            min_w: 640.0,
            min_h: 360.0,
            toolbar: Vec::new(),
            menu: Vec::new(),
            status_panels: vec![210.0, 120.0, 100.0, 50.0],
            actions: HashMap::new(),
        }
    }
}

fn item_of(o: &Object, actions: &HashMap<String, ActionInfo>) -> Item {
    let action = o.str_prop("Action").map(str::to_string);
    let info = action.as_ref().and_then(|a| actions.get(a));
    let caption = o.str_prop("Caption").map(str::to_string).or_else(|| info.map(|i| i.caption.clone())).unwrap_or_default();
    let hint = o.str_prop("Hint").map(str::to_string).or_else(|| info.map(|i| i.hint.clone())).unwrap_or_default();
    Item {
        name: o.name.clone(),
        separator: caption == "-" || (o.class == "TToolButton" && o.str_prop("Action").is_none() && o.int_prop("Width") == Some(8) && caption.is_empty()),
        action,
        caption,
        hint,
        children: o.children.iter().map(|c| item_of(c, actions)).collect(),
    }
}

/// Build the main-window spec from a parsed `TMainForm`.
pub fn main_spec_from(form: &Object) -> MainFormSpec {
    let mut spec = MainFormSpec::default();
    if let Some(c) = form.str_prop("Caption") {
        spec.caption = c.to_string();
    }
    if let (Some(w), Some(h)) = (form.int_prop("ClientWidth"), form.int_prop("ClientHeight")) {
        spec.client_w = w as f32;
        spec.client_h = h as f32;
    }
    if let Some(m) = form.int_prop("Constraints.MinWidth").filter(|&m| m > 0) {
        spec.min_w = m as f32;
    }
    if let Some(m) = form.int_prop("Constraints.MinHeight").filter(|&m| m > 0) {
        spec.min_h = m as f32;
    }
    if let Some(am) = form.find("ActionManager") {
        for a in &am.children {
            spec.actions.insert(
                a.name.clone(),
                ActionInfo {
                    caption: a.str_prop("Caption").unwrap_or_default().to_string(),
                    hint: a.str_prop("Hint").unwrap_or_default().to_string(),
                    shortcut: a.int_prop("ShortCut").unwrap_or(0),
                },
            );
        }
    }
    if let Some(tb) = form.find("MainToolBar") {
        spec.toolbar = tb.children.iter().map(|c| item_of(c, &spec.actions)).collect();
    }
    if let Some(m) = form.find("MainMenu") {
        spec.menu = m.children.iter().map(|c| item_of(c, &spec.actions)).collect();
    }
    if let Some(sb) = form.find("StatusBar") {
        if let Some(Value::Collection(panels)) = sb.prop("Panels") {
            let w: Vec<f32> = panels
                .iter()
                .map(|p| p.iter().find(|(k, _)| k == "Width").and_then(|(_, v)| if let Value::Int(i) = v { Some(*i as f32) } else { None }).unwrap_or(100.0))
                .collect();
            if !w.is_empty() {
                spec.status_panels = w;
            }
        }
    }
    spec
}

/// The main-window spec from the embedded `form_TMAINFORM.dfm` (defaults if it ever fails to parse).
pub fn main_spec() -> &'static MainFormSpec {
    static SPEC: OnceLock<MainFormSpec> = OnceLock::new();
    SPEC.get_or_init(|| parse(MAIN_FORM).map(|f| main_spec_from(&f)).unwrap_or_default())
}

/// Layout of the About box (`TJamAboutForm`): client size and label captions by component name.
#[derive(Debug, Clone, Default)]
pub struct AboutSpec {
    pub client_w: f32,
    pub client_h: f32,
    pub labels: HashMap<String, String>,
    /// (name, left, top) of the labels, in DFM order.
    pub positions: Vec<(String, f32, f32)>,
}

pub fn about_spec() -> &'static AboutSpec {
    static SPEC: OnceLock<AboutSpec> = OnceLock::new();
    SPEC.get_or_init(|| {
        let mut s = AboutSpec { client_w: 600.0, client_h: 448.0, ..Default::default() };
        if let Ok(f) = parse(ABOUT_FORM) {
            s.client_w = f.int_prop("ClientWidth").unwrap_or(600) as f32;
            s.client_h = f.int_prop("ClientHeight").unwrap_or(448) as f32;
            for c in &f.children {
                if let (true, Some(cap)) = (c.class == "TLabel" || c.class == "TPanel", c.str_prop("Caption")) {
                    s.labels.insert(c.name.clone(), cap.to_string());
                }
                if c.int_prop("Left").is_none() {
                    continue;
                }
                s.positions.push((c.name.clone(), c.int_prop("Left").unwrap_or(0) as f32, c.int_prop("Top").unwrap_or(0) as f32));
            }
        }
        s
    })
}

/// Strings of the `VS_VERSION_INFO` resource of the original executable.
pub fn version_info() -> &'static HashMap<String, String> {
    static INFO: OnceLock<HashMap<String, String>> = OnceLock::new();
    INFO.get_or_init(|| parse_version_info(VERSION_RES))
}

/// Extract `StringFileInfo` pairs from a raw `RT_VERSION` blob (UTF-16). Walks the NUL-separated
/// strings: a key is the token that ends with one of the well-known names (header words are glued to
/// it), its value is the next token.
pub fn parse_version_info(data: &[u8]) -> HashMap<String, String> {
    const KEYS: [&str; 8] = [
        "CompanyName",
        "FileDescription",
        "FileVersion",
        "LegalCopyright",
        "ProductName",
        "ProductVersion",
        "Comments",
        "OriginalFilename",
    ];
    let units: Vec<u16> = data.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
    let tokens: Vec<String> = units
        .split(|&u| u == 0)
        .filter(|t| !t.is_empty())
        .map(String::from_utf16_lossy)
        .collect();
    let mut out = HashMap::new();
    for (i, t) in tokens.iter().enumerate() {
        if let Some(k) = KEYS.iter().find(|k| t.ends_with(**k)) {
            if let Some(v) = tokens.get(i + 1) {
                out.entry((*k).to_string()).or_insert_with(|| v.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_forms() -> Vec<std::path::PathBuf> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/rcdata");
        let mut v: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|e| e == "dfm"))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn all_21_forms_parse() {
        let forms = all_forms();
        assert_eq!(forms.len(), 21);
        for p in forms {
            let bytes = std::fs::read(&p).unwrap();
            let o = parse(&bytes).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            assert!(!o.class.is_empty() && !o.name.is_empty(), "{}", p.display());
        }
    }

    #[test]
    fn main_form_properties() {
        let f = parse(MAIN_FORM).unwrap();
        assert_eq!(f.class, "TMainForm");
        assert_eq!(f.name, "MainForm");
        assert_eq!(f.str_prop("Caption"), Some("TreeSize Free"));
        assert_eq!(f.int_prop("ClientWidth"), Some(900));
        assert_eq!(f.int_prop("ClientHeight"), Some(750));
        for n in ["DirectoryTree", "MainToolBar", "StatusBar", "MainMenu", "ActionManager", "RefreshAction"] {
            assert!(f.find(n).is_some(), "{n}");
        }
        assert_eq!(f.find("DirectoryTree").unwrap().class, "TVirtualStringTreeEx");
        assert!(f.count() > 300);
    }

    #[test]
    fn main_spec_is_filled_from_the_dfm() {
        let s = main_spec();
        assert_eq!((s.client_w, s.client_h), (900.0, 750.0));
        assert_eq!(s.caption, "TreeSize Free");
        assert_eq!(s.status_panels, vec![210.0, 120.0, 100.0, 50.0]);
        let tb: Vec<&str> = s.toolbar.iter().filter_map(|i| i.action.as_deref()).take(5).collect();
        assert_eq!(tb, ["ParentFolderAction", "ScanDirectoryAction", "StopScanAction", "RefreshAction", "PrintAction"]);
        assert!(s.toolbar.iter().any(|i| i.separator));
        let top: Vec<&str> = s.menu.iter().map(|m| m.caption.as_str()).collect();
        assert_eq!(&top[..3], ["&File", "&Scan", "&View"]);
        assert!(top.contains(&"&Help"));
        let file = &s.menu[0];
        assert_eq!(file.children[0].action.as_deref(), Some("RefreshAction"));
        assert_eq!(file.children[0].caption, "&Refresh", "caption resolved from the action");
        assert!(file.children.iter().any(|c| c.separator));
        assert_eq!(s.actions["StopScanAction"].caption, "S&top Scan");
        assert_eq!(s.actions["StopScanAction"].hint, "Stop scanning");
        assert_eq!(s.actions["PrintAction"].shortcut, 16464);
    }

    #[test]
    fn about_spec_and_version_info() {
        let a = about_spec();
        assert_eq!((a.client_w, a.client_h), (600.0, 448.0));
        assert_eq!(a.labels.get("AboutLabel").map(String::as_str), Some("About %s"));
        assert!(a.positions.iter().any(|(n, _, _)| n == "ProductNameLabel"));
        let v = version_info();
        assert_eq!(v.get("ProductName").map(String::as_str), Some("TreeSize Free"));
        assert_eq!(v.get("ProductVersion").map(String::as_str), Some("4.7.3"));
        assert!(v.get("CompanyName").is_some_and(|c| c.contains("JAM")));
    }

    #[test]
    fn rejects_bad_input_without_panicking() {
        assert!(parse(b"").is_err());
        assert!(parse(b"NOPE").is_err());
        assert!(parse(b"TPF0").is_err());
        let truncated = &MAIN_FORM[..MAIN_FORM.len() / 2];
        assert!(parse(truncated).is_err());
        // Every prefix must fail cleanly (no panic, no overflow).
        for n in (0..400).step_by(7) {
            let _ = parse(&MAIN_FORM[..n]);
        }
    }

    #[test]
    fn synthetic_form_value_types() {
        let mut b = b"TPF0".to_vec();
        b.extend([4, b'T', b'F', b'r', b'm', 1, b'F']); // class "TFrm", name "F"
        b.extend([5, b'W', b'i', b'd', b't', b'h', 3, 0x2c, 0x01]); // Width = 300 (int16)
        b.extend([4, b'F', b'l', b'a', b'g', 9]); // Flag = True
        b.extend([1, b'S', 6, 2, b'h', b'i']); // S = 'hi'
        b.push(0); // end of props
        b.push(0); // end of children
        let o = parse(&b).unwrap();
        assert_eq!(o.class, "TFrm");
        assert_eq!(o.int_prop("Width"), Some(300));
        assert_eq!(o.prop("Flag"), Some(&Value::Bool(true)));
        assert_eq!(o.str_prop("S"), Some("hi"));
    }
}
