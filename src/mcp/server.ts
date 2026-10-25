import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EngineDetector } from "../core/detector/engine-detector.js";
import { AdapterRegistry } from "../adapters/index.js";
import { ReaBridge } from "../rea/rea-bridge.js";
import { ASSET_CATEGORIES, type AssetCategory } from "../types/index.js";
import { validateCategories } from "../utils/file-utils.js";
import { DecompilerRegistry } from "../decompiler/decompiler-registry.js";
import type { DecompilerBackendType } from "../decompiler/types.js";
import { ApplicationAuditor } from "../pipeline/application-auditor.js";

const DEFAULT_INSPECT_LIMIT = 200;

type ToolArgs = Record<string, unknown> | undefined;

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Read a required non-empty string argument or fail with a clear message */
function requireString(args: ToolArgs, key: string): string {
  const value = args?.[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing or invalid argument '${key}': expected a non-empty string.`);
  }
  return value;
}

function optionalString(args: ToolArgs, key: string): string | undefined {
  const value = args?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid argument '${key}': expected a string.`);
  }
  return value.length > 0 ? value : undefined;
}

function optionalCategories(args: ToolArgs): AssetCategory[] | undefined {
  const value = args?.categories;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error("Invalid argument 'categories': expected an array of strings.");
  }
  const { valid, invalid } = validateCategories(value as string[]);
  if (invalid.length > 0) {
    throw new Error(`Unknown categories: ${invalid.join(", ")}. Valid categories: ${ASSET_CATEGORIES.join(", ")}.`);
  }
  return valid;
}

function optionalBoolean(args: ToolArgs, key: string): boolean | undefined {
  const value = args?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Invalid argument '${key}': expected a boolean.`);
  }
  return value;
}

function optionalLimit(args: ToolArgs): number {
  const value = args?.limit;
  if (value === undefined || value === null) return DEFAULT_INSPECT_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("Invalid argument 'limit': expected a non-negative integer.");
  }
  return value;
}

let configuredRoots: string[] | undefined;

/** Override the allow-list of root directories (e.g. from `ripper mcp --root`); undefined falls back to UAR_ALLOWED_ROOTS */
export function setAllowedRoots(roots: string[] | undefined): void {
  configuredRoots = roots && roots.length > 0 ? roots : undefined;
}

function activeRoots(): string[] | undefined {
  if (configuredRoots) return configuredRoots;
  const env = process.env.UAR_ALLOWED_ROOTS?.trim();
  if (!env) return undefined;
  const roots = env.split(path.delimiter).filter((r) => r.trim().length > 0);
  return roots.length > 0 ? roots : undefined;
}

/** Resolve a path through symlinks as far as it exists, then append the not-yet-existing tail */
async function realResolve(p: string): Promise<string> {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) return false;
  return true;
}

/** Fail unless the path resolves inside one of the allowed roots (no-op when no allow-list is set) */
async function assertAllowed(key: string, value: string | undefined): Promise<void> {
  const roots = activeRoots();
  if (!roots || value === undefined) return;
  const target = await realResolve(value);
  for (const root of roots) {
    if (isInside(await realResolve(root), target)) return;
  }
  throw new Error(`Access denied: '${key}' (${value}) is outside the allowed root directories.`);
}

/**
 * Execute one MCP tool call. Errors (including invalid arguments) come back as isError results.
 */
export async function callTool(name: string, args: ToolArgs) {
  try {
    if (name === "ripper_detect") {
      const targetPath = requireString(args, "targetPath");
      await assertAllowed("targetPath", targetPath);
      return jsonResult(await EngineDetector.detect(targetPath));
    }

    if (name === "ripper_inspect") {
      const targetPath = requireString(args, "targetPath");
      await assertAllowed("targetPath", targetPath);
      const limit = optionalLimit(args);
      const aesKey = optionalString(args, "aesKey");
      const { adapter } = await AdapterRegistry.resolveAdapter(targetPath);
      const manifest = await adapter.inspect(targetPath, { aesKey });
      // Large games have tens of thousands of assets: return totals plus a bounded asset list
      return jsonResult({
        ...manifest,
        assets: manifest.assets.slice(0, limit),
        assetsReturned: Math.min(limit, manifest.assets.length),
        assetsTruncated: manifest.assets.length > limit
      });
    }

    if (name === "ripper_extract") {
      const targetPath = requireString(args, "targetPath");
      const outputDir = requireString(args, "outputDir");
      const categories = optionalCategories(args);
      const filter = optionalString(args, "filter");
      const aesKey = optionalString(args, "aesKey");
      const dryRun = optionalBoolean(args, "dryRun");
      await assertAllowed("targetPath", targetPath);
      await assertAllowed("outputDir", outputDir);
      const convertFormats = optionalBoolean(args, "convertFormats");

      const { adapter } = await AdapterRegistry.resolveAdapter(targetPath);
      const result = await adapter.extract(targetPath, {
        outputDir,
        categories,
        filter,
        aesKey,
        convertFormats,
        dryRun
      });
      return jsonResult(result);
    }

    if (name === "ripper_scan_binary") {
      const binaryPath = requireString(args, "binaryPath");
      const pakPath = optionalString(args, "pakPath");
      await assertAllowed("binaryPath", binaryPath);
      await assertAllowed("pakPath", pakPath);
      return jsonResult(await ReaBridge.inspectBinary(binaryPath, { pakPath }));
    }

    if (name === "ripper_decompiler_status") {
      return jsonResult(await DecompilerRegistry.getAvailableBackends());
    }

    if (name === "ripper_disassemble") {
      const binaryPath = requireString(args, "binaryPath");
      await assertAllowed("binaryPath", binaryPath);
      const functionOrAddress = optionalString(args, "functionOrAddress");
      const backend = optionalString(args, "backend") as DecompilerBackendType | undefined;
      const count = typeof args?.count === "number" ? args.count : undefined;
      const syntax = (args?.syntax === "att" ? "att" : "intel") as "intel" | "att";
      const result = await DecompilerRegistry.disassemble(binaryPath, {
        functionOrAddress,
        backend,
        count,
        syntax
      });
      return jsonResult(result);
    }

    if (name === "ripper_dump_symbols") {
      const binaryPath = requireString(args, "binaryPath");
      await assertAllowed("binaryPath", binaryPath);
      const filter = optionalString(args, "filter");
      const result = await DecompilerRegistry.dumpSymbols(binaryPath, filter);
      return jsonResult(result);
    }

    if (name === "ripper_decompile") {
      const binaryPath = requireString(args, "binaryPath");
      await assertAllowed("binaryPath", binaryPath);
      const functionOrAddress = optionalString(args, "functionOrAddress");
      const backend = optionalString(args, "backend") as DecompilerBackendType | undefined;
      const result = await DecompilerRegistry.decompile(binaryPath, {
        functionOrAddress,
        backend
      });
      return jsonResult(result);
    }

    if (name === "ripper_audit_directory") {
      const targetDir = requireString(args, "targetDir");
      await assertAllowed("targetDir", targetDir);
      const outputDir = optionalString(args, "outputDir");
      if (outputDir) await assertAllowed("outputDir", outputDir);
      const maxDepth = typeof args?.maxDepth === "number" ? args.maxDepth : undefined;
      const decompile = typeof args?.decompile === "boolean" ? args.decompile : true;
      const result = await ApplicationAuditor.auditDirectory(targetDir, {
        outputDir,
        maxDepth,
        decompile
      });
      return jsonResult(result);
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err: unknown) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`
        }
      ]
    };
  }
}

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: "universal-asset-ripper",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "ripper_detect",
          description: "Detect the game engine (Unity, Unreal Engine, Godot) or Windows desktop software (PE: Delphi, C++, .NET, Qt, Rust, Go, Electron).",
          inputSchema: {
            type: "object",
            properties: {
              targetPath: {
                type: "string",
                description: "Path to the target directory or executable (.exe, .pck, .pak, .bundle)"
              }
            },
            required: ["targetPath"]
          }
        },
        {
          name: "ripper_inspect",
          description: "Inspect game assets, listing counts and sizes by category (textures, meshes, audio, scenes, scripts).",
          inputSchema: {
            type: "object",
            properties: {
              targetPath: {
                type: "string",
                description: "Path to the game folder or asset container"
              },
              limit: {
                type: "integer",
                minimum: 0,
                description: "Maximum number of assets to return in the list (default 200). Totals always cover every asset."
              },
              aesKey: {
                type: "string",
                description: "Optional AES-256 key to list encrypted containers (Unreal .pak index, Godot encrypted PCK)"
              }
            },
            required: ["targetPath"]
          }
        },
        {
          name: "ripper_extract",
          description: "Extract assets from game package with optional category filtering and AES key support.",
          inputSchema: {
            type: "object",
            properties: {
              targetPath: {
                type: "string",
                description: "Path to the game folder or container"
              },
              outputDir: {
                type: "string",
                description: "Directory where extracted assets should be saved"
              },
              categories: {
                type: "array",
                items: {
                  type: "string",
                  enum: [...ASSET_CATEGORIES]
                },
                description: "Optional list of asset categories to extract"
              },
              filter: {
                type: "string",
                description: "Substring filter to match asset paths"
              },
              aesKey: {
                type: "string",
                description: "AES-256 decryption key for encrypted Unreal .pak containers (hex/base64) or Godot encrypted PCK (hex)"
              },
              convertFormats: {
                type: "boolean",
                description: "Convert formats while extracting (Godot .ctex/.stex wrapping a plain PNG/WebP are written as images)"
              },
              dryRun: {
                type: "boolean",
                description: "Report what would be extracted without writing any files"
              }
            },
            required: ["targetPath", "outputDir"]
          }
        },
        {
          name: "ripper_scan_binary",
          description: "Scan an executable or binary for candidate AES keys, IL2CPP metadata, and REA evidence bundle.",
          inputSchema: {
            type: "object",
            properties: {
              binaryPath: {
                type: "string",
                description: "Path to the game executable or binary (.exe, .dll, .so)"
              },
              pakPath: {
                type: "string",
                description: "Optional Unreal .pak used to verify each candidate key (verified keys are listed first)"
              }
            },
            required: ["binaryPath"]
          }
        },
        {
          name: "ripper_decompiler_status",
          description: "List all reverse engineering and decompiler engines (Ghidra, Cutter, Hopper, IDA, Binutils) and their readiness status.",
          inputSchema: {
            type: "object",
            properties: {}
          }
        },
        {
          name: "ripper_disassemble",
          description: "Disassemble native binary machine code instructions (via Binutils, Cutter, Ghidra, Hopper, or IDA).",
          inputSchema: {
            type: "object",
            properties: {
              binaryPath: {
                type: "string",
                description: "Path to the binary file (.exe, .dll, ELF, Mach-O)"
              },
              functionOrAddress: {
                type: "string",
                description: "Function name or hexadecimal address to start disassembling"
              },
              backend: {
                type: "string",
                enum: ["auto", "binutils", "cutter", "ghidra", "hopper", "ida"],
                description: "Decompiler engine backend to use (defaults to 'auto')"
              },
              count: {
                type: "integer",
                minimum: 1,
                maximum: 5000,
                description: "Maximum number of instructions to disassemble (default 100)"
              },
              syntax: {
                type: "string",
                enum: ["intel", "att"],
                description: "Assembly syntax flavour (default 'intel')"
              }
            },
            required: ["binaryPath"]
          }
        },
        {
          name: "ripper_dump_symbols",
          description: "Dump symbols (functions, global data, imports, exports) from an executable or library.",
          inputSchema: {
            type: "object",
            properties: {
              binaryPath: {
                type: "string",
                description: "Path to the binary file (.exe, .dll, ELF, Mach-O)"
              },
              filter: {
                type: "string",
                description: "Optional substring filter to match symbol names"
              }
            },
            required: ["binaryPath"]
          }
        },
        {
          name: "ripper_decompile",
          description: "Decompile binary machine code to high-level C / pseudocode using Ghidra, Cutter, or IDA.",
          inputSchema: {
            type: "object",
            properties: {
              binaryPath: {
                type: "string",
                description: "Path to the binary file (.exe, .dll, ELF, Mach-O)"
              },
              functionOrAddress: {
                type: "string",
                description: "Function name or address to decompile"
              },
              backend: {
                type: "string",
                enum: ["auto", "ghidra", "cutter", "ida"],
                description: "Decompiler engine to use"
              }
            },
            required: ["binaryPath"]
          }
        },
        {
          name: "ripper_audit_directory",
          description: "Run automated end-to-end reverse engineering, asset discovery, PE resource extraction, and multi-binary audit across an application directory.",
          inputSchema: {
            type: "object",
            properties: {
              targetDir: {
                type: "string",
                description: "Path to the application or game installation directory"
              },
              outputDir: {
                type: "string",
                description: "Optional directory where audit-report.json and audit-report.md will be saved"
              },
              maxDepth: {
                type: "integer",
                minimum: 1,
                maximum: 10,
                description: "Maximum directory recursion depth (default 4)"
              },
              decompile: {
                type: "boolean",
                description: "Run targeted decompilation on key functions via Ghidra/Cutter if available"
              }
            },
            required: ["targetDir"]
          }
        }
      ]
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(name, args);
  });

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
