# Decompiler & Reverse Engineering Backends Guide

`universal-asset-ripper` integrates support for the industry's five leading reverse engineering and binary analysis engines: **NSA Ghidra**, **Cutter / Rizin**, **Hopper Disassembler**, **IDA Pro / Hex-Rays**, and **GNU Binutils / LLVM**.

This guide covers setup, capabilities, environment variables, CLI commands, and MCP orchestration.

---

## 1. Engine Capabilities Matrix

| Engine | Primary Language / Platform | Disassembly | Decompilation | Symbols & Imports | Control Flow Graph | Zero-Install Baseline |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **GNU Binutils** (`objdump`, `nm`, `strings`) | Native C/C++ / All platforms | ✔ | ✖ | ✔ | ✖ | **✔ (Default on MSYS2/PATH)** |
| **NSA Ghidra** | Java / Sleigh decompiler | ✔ | ✔ (C) | ✔ | ✔ | ✖ (Requires JDK 17/21 + Ghidra) |
| **Cutter / Rizin** | C++ / Qt / Rizin engine | ✔ | ✔ (Ghidra/rz-ghidra) | ✔ | ✔ | ✖ (Stand-alone app / winget) |
| **Hopper Disassembler** | Objective-C / macOS / Linux / Win | ✔ | ✔ (Pseudo-C) | ✔ | ✔ | ✖ (Commercial) |
| **IDA Pro / Free** | Native C++ / Hex-Rays | ✔ | ✔ (Hex-Rays) | ✔ | ✔ | ✖ (Commercial / Free tier) |

---

## 2. Installation & Configuration

### A. GNU Binutils (Zero-Install Baseline)
Binutils is already available on systems with MSYS2, Git for Windows, MinGW, or Linux/macOS toolchains.
- Checked locations: `C:\msys64\ucrt64\bin`, `C:\msys64\mingw64\bin`, `C:\Program Files\Git\usr\bin`, or system `PATH`.
- Verification: `ripper decompilers`

### B. NSA Ghidra
Ghidra provides headless script execution and automated C decompilation.
- **Windows (via winget)**:
  ```powershell
  winget install NSA.Ghidra
  ```
- **Manual Zip download**:
  Download from [NSA Ghidra Releases](https://github.com/NationalSecurityAgency/ghidra/releases) and extract to `C:\tools\ghidra`.
- **Environment variable**:
  ```powershell
  [Environment]::SetEnvironmentVariable("GHIDRA_INSTALL_DIR", "C:\tools\ghidra_11.x", "User")
  $env:GHIDRA_INSTALL_DIR = "C:\tools\ghidra_11.x"
  ```
- **Prerequisite**: Java JDK 17 or JDK 21 (`JAVA_HOME` set).

### C. Cutter / Rizin
Cutter is an open-source reverse engineering framework powered by Rizin.
- **Windows (via winget)**:
  ```powershell
  winget install Rizin.Cutter
  ```
- **Environment variable**:
  ```powershell
  [Environment]::SetEnvironmentVariable("CUTTER_PATH", "C:\Program Files\Cutter\cutter.exe", "User")
  $env:CUTTER_PATH = "C:\Program Files\Cutter\cutter.exe"
  ```

### D. Hopper Disassembler
Hopper specializes in 32-bit and 64-bit x86 and ARM binaries.
- **Download**: [hopperapp.com](https://www.hopperapp.com/)
- **Environment variable**:
  ```powershell
  [Environment]::SetEnvironmentVariable("HOPPER_PATH", "C:\Program Files\Hopper Disassembler v4\hopper.exe", "User")
  $env:HOPPER_PATH = "C:\Program Files\Hopper Disassembler v4\hopper.exe"
  ```

### E. IDA Pro / Hex-Rays
IDA Pro can be driven in headless/batch mode via `idat64.exe` or `ida64.exe`.
- **Environment variable**:
  ```powershell
  [Environment]::SetEnvironmentVariable("IDA_PATH", "C:\Program Files\IDA Pro 8.4\idat64.exe", "User")
  $env:IDA_PATH = "C:\Program Files\IDA Pro 8.4\idat64.exe"
  ```

---

## 3. CLI Commands

### Inspect Engine Status
```bash
ripper decompilers
# or as JSON:
ripper decompilers --json
```

### Disassemble Binary Code
Disassembles machine instructions with Intel syntax, opcodes, and virtual addresses:
```bash
# Disassemble first 50 instructions
ripper disasm "C:\Program Files\Notepad++\notepad++.exe" -n 50

# Disassemble with specific function target or address
ripper disasm "C:\Program Files\Notepad++\notepad++.exe" -f "140001000" -n 25

# Select explicit backend (binutils, cutter, ghidra, hopper, ida)
ripper disasm "C:\Program Files\Notepad++\notepad++.exe" --backend binutils
```

### Dump Symbols, Functions & Imports
Extracts the symbol table, imported APIs, and addresses:
```bash
# Dump all symbols
ripper symbols "C:\Program Files\Notepad++\notepad++.exe"

# Filter by API or DLL name
ripper symbols "C:\Program Files\Notepad++\notepad++.exe" --filter "Create"
ripper symbols "C:\Program Files\Notepad++\notepad++.exe" --filter "USER32"
```

### Decompile Function to C
Decompiles binary machine code into high-level C/pseudocode using Ghidra or Cutter:
```bash
ripper decompile "target.exe" -f "MainEntryPoint" --backend ghidra -o ./decompiled_main.c
```

### Environment Doctor Check
```bash
ripper doctor
```

---

## 4. MCP Tools for AI Agents

When `universal-asset-ripper` runs as an MCP server (`ripper mcp`), agents have access to:

1. **`ripper_decompiler_status`**: Queries all installed decompiler backends and their readiness.
2. **`ripper_disassemble`**: Disassembles machine code with instruction counts, offsets, and syntax options.
3. **`ripper_dump_symbols`**: Retrieves function and import symbols with optional substring filter.
4. **`ripper_decompile`**: Requests headless decompilation of target procedures.
