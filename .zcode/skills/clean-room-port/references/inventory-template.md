# Inventory document template

Copy this structure into `<port>/docs/inventory.md`. Every row carries a
coverage status: ✅ implemented · 🟡 partial · ❌ absent · n/a. Precision
beats completeness: an honest ❌ backlog is more useful than vague wording.

```markdown
# <Software> <version> — precise inventory vs <port> coverage

Produced with universal-asset-ripper (clean-room, no decompilation):
ripper detect/extract over the installation, dialog decoding, built-in
usage capture, embedded help texts. See the clean-room workflow doc.

## 1. Executables

| Executable | Role (from resources/usage) | <port> status |
|---|---|---|

## 2. Libraries (DLLs)

| Library | Role | Replaced in <port> by |
|---|---|---|

## 3. GUI — tabs (embedded help) and dialogs (decoded)

| Tab | Purpose (from help text) | status |
|---|---|---|

Decoded dialogs grouped by function, with ids and decoded titles:

- **<function>**: `#<id>` title (key control labels…)
- …

## 4. CLI option surface (captured usage)

Table or list of the original options → supported / rejected (explicit
error) / ignored.

## 5. Coverage summary

- <area>: ✅/🟡/❌ one line each, with the main gaps named.
```

Rules of thumb:

- The dialog table comes from `dialogs/*.json` (controlCount > 0 or a
  real title); ignore empty decoded stubs.
- Map each proprietary DLL to its open-source replacement (or ❌).
- Date the document and the tool version used for extraction.
