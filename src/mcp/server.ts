import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { EngineDetector } from "../core/detector/engine-detector.js";
import { AdapterRegistry } from "../adapters/index.js";
import { ReaBridge } from "../rea/rea-bridge.js";
import { ASSET_CATEGORIES, type AssetCategory } from "../types/index.js";
import { validateCategories } from "../utils/file-utils.js";

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

/**
 * Execute one MCP tool call. Errors (including invalid arguments) come back as isError results.
 */
export async function callTool(name: string, args: ToolArgs) {
  try {
    if (name === "ripper_detect") {
      const targetPath = requireString(args, "targetPath");
      return jsonResult(await EngineDetector.detect(targetPath));
    }

    if (name === "ripper_inspect") {
      const targetPath = requireString(args, "targetPath");
      const limit = optionalLimit(args);
      const { adapter } = await AdapterRegistry.resolveAdapter(targetPath);
      const manifest = await adapter.inspect(targetPath);
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

      const { adapter } = await AdapterRegistry.resolveAdapter(targetPath);
      const result = await adapter.extract(targetPath, {
        outputDir,
        categories,
        filter,
        aesKey,
        dryRun
      });
      return jsonResult(result);
    }

    if (name === "ripper_scan_binary") {
      const binaryPath = requireString(args, "binaryPath");
      return jsonResult(await ReaBridge.inspectBinary(binaryPath));
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
                description: "AES-256 decryption key for encrypted Unreal .pak containers"
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
              }
            },
            required: ["binaryPath"]
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
