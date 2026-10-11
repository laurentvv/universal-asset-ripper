import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { EngineDetector } from "../core/detector/engine-detector.js";
import { AdapterRegistry } from "../adapters/index.js";
import { ReaBridge } from "../rea/rea-bridge.js";
import type { AssetCategory } from "../types/index.js";

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
          description: "Detect the game engine (Unity, Unreal Engine, Godot) or Windows desktop software (PE, Delphi, .NET, Electron).",
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
                  enum: [
                    "texture",
                    "mesh",
                    "audio",
                    "scene",
                    "script",
                    "shader",
                    "font",
                    "video",
                    "animation",
                    "config",
                    "other"
                  ]
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

    try {
      if (name === "ripper_detect") {
        const targetPath = String(args?.targetPath);
        const result = await EngineDetector.detect(targetPath);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      if (name === "ripper_inspect") {
        const targetPath = String(args?.targetPath);
        const { adapter } = await AdapterRegistry.resolveAdapter(targetPath);
        const manifest = await adapter.inspect(targetPath);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(manifest, null, 2)
            }
          ]
        };
      }

      if (name === "ripper_extract") {
        const targetPath = String(args?.targetPath);
        const outputDir = String(args?.outputDir);
        const categories = args?.categories as AssetCategory[] | undefined;
        const filter = args?.filter ? String(args.filter) : undefined;
        const aesKey = args?.aesKey ? String(args.aesKey) : undefined;

        const { adapter } = await AdapterRegistry.resolveAdapter(targetPath);
        const result = await adapter.extract(targetPath, {
          outputDir,
          categories,
          filter,
          aesKey
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      if (name === "ripper_scan_binary") {
        const binaryPath = String(args?.binaryPath);
        const inspection = await ReaBridge.inspectBinary(binaryPath);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(inspection, null, 2)
            }
          ]
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (err: unknown) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`
          }
        ]
      };
    }
  });

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
