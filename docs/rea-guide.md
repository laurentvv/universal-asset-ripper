# REA (Reverse Engineer Anything) Integration Guide

## 1. Context & Motivation

When extracting game assets, standard tools often encounter barriers:
1. **Unreal Engine:** `.pak` or `.ucas` packages encrypted with AES-256 where the key is unknown.
2. **Unity:** IL2CPP builds where C# bytecode has been converted to machine code, or obfuscated `global-metadata.dat`.
3. **Custom Packers:** Proprietary encryption wrappers around standard game engines.

To resolve these challenges without manual static disassembly, **Universal Asset Ripper** connects to **[morluto/rea](https://github.com/morluto/rea)** (`rea-agents`).

---

## 2. Automated Deep Binary Inspection

Run the built-in scanner to identify candidate keys and architectural properties:

```bash
ripper rea-inspect path/to/Game-Win64-Shipping.exe
```

### What `BinaryScanner` Analyzes:
1. **Shannon Entropy Analysis:** Identifies 32-byte (256-bit) blocks of high randomness characteristic of cryptographic keys.
2. **Hex Pattern Matching:** Detects strings matching 64-character hexadecimal patterns (`0x[A-Fa-f0-9]{64}`).
3. **Cryptographic Proximity:** Scans for Rijndael AES SubBytes S-Box constants (`0x63, 0x7c, 0x77, 0x7b...`) and analyzes adjacent memory blocks.
4. **IL2CPP Metadata Headers:** Inspects `global-metadata.dat` for the magic signature `0xFAB11BAF` and metadata version.

---

## 3. Evidence Bundle Format

When `ReaBridge.inspectBinary()` runs, it outputs an **Evidence Bundle** formatted for AI agents:

```json
{
  "targetBinary": "C:/Games/Title/Game-Win64-Shipping.exe",
  "architecture": "x64",
  "evidenceType": "GameBinaryAnalysis",
  "timestamp": "2026-10-11T13:00:00.000Z",
  "findings": {
    "candidateAesKeys": [
      {
        "key": "0x4a6b8d1f3c5e7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e0f2a4b6c8d0e2f4a6b",
        "offset": 512,
        "confidence": "high"
      }
    ],
    "il2cppVersion": null,
    "signatures": ["UnrealEngine signature", "FArchive"]
  },
  "reaTaskPrompt": "Target: Game-Win64-Shipping.exe (x64)\nCandidate AES keys detected: 0x4a6b...\nObjective: Confirm decryption keys / recovery offsets."
}
```

---

## 4. Using with AI Agents & MCP

Configure `universal-asset-ripper` in your MCP client (e.g. Claude Code, Gemini CLI, Cursor, Antigravity) by adding to your `mcpServers` configuration:

```json
{
  "mcpServers": {
    "universal-asset-ripper": {
      "command": "node",
      "args": ["C:/git/universal-asset-ripper/dist/cli/index.js", "mcp"]
    }
  }
}
```

The AI agent can then directly call:
* `ripper_detect`
* `ripper_inspect`
* `ripper_extract`
* `ripper_scan_binary`
