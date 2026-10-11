import type { EngineType, IEngineAdapter } from "../types/index.js";
import { EngineDetector } from "../core/detector/engine-detector.js";
import { GodotAdapter } from "./godot-adapter.js";
import { UnrealAdapter } from "./unreal-adapter.js";
import { UnityAdapter } from "./unity-adapter.js";
import { PeSoftwareAdapter } from "./pe-adapter.js";

export { BaseEngineAdapter } from "./engine-adapter.js";
export { GodotAdapter } from "./godot-adapter.js";
export { UnrealAdapter } from "./unreal-adapter.js";
export { UnityAdapter } from "./unity-adapter.js";
export { PeSoftwareAdapter } from "./pe-adapter.js";

export class AdapterRegistry {
  private static adapters: Map<EngineType, IEngineAdapter> = new Map<EngineType, IEngineAdapter>([
    ["godot", new GodotAdapter() as IEngineAdapter],
    ["unreal", new UnrealAdapter() as IEngineAdapter],
    ["unity", new UnityAdapter() as IEngineAdapter],
    ["pe-software", new PeSoftwareAdapter() as IEngineAdapter]
  ]);

  static getAdapter(engine: EngineType): IEngineAdapter | undefined {
    return this.adapters.get(engine);
  }

  /**
   * Automatically resolve the appropriate adapter for a target path
   */
  static async resolveAdapter(targetPath: string): Promise<{ adapter: IEngineAdapter; engine: EngineType }> {
    const detection = await EngineDetector.detect(targetPath);
    const adapter = this.getAdapter(detection.engine);

    if (!adapter) {
      throw new Error(
        `No adapter available for detected engine '${detection.engine}' on target: ${targetPath}`
      );
    }

    return { adapter, engine: detection.engine };
  }
}
