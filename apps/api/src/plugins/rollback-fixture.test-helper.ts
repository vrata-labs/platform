import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const PLUGIN_ROLLBACK_SHA = "81c14b6ac8dbc537892f7b1f342ca8f718fdf0a6";
export const PLUGIN_ROLLBACK_MODULE_ENV = "VRATA_PLUGIN_ROLLBACK_STORAGE_MODULE";
const execute = promisify(execFile);

export function pluginRollbackModuleSetting(env: NodeJS.ProcessEnv): string | undefined {
  const path = env[PLUGIN_ROLLBACK_MODULE_ENV]?.trim();
  if (env.CI && !path) throw new Error(`CI requires ${PLUGIN_ROLLBACK_MODULE_ENV} from the independently checked out and built ${PLUGIN_ROLLBACK_SHA}`);
  return path || undefined;
}

export async function assertLocalPluginRollbackObject(workspace: string): Promise<void> {
  try { await execute("git", ["cat-file", "-e", `${PLUGIN_ROLLBACK_SHA}^{commit}`], { cwd: workspace }); }
  catch (cause) {
    throw new Error(`plugin_rollback_source_unavailable: prepare and build ${PLUGIN_ROLLBACK_SHA} and set ${PLUGIN_ROLLBACK_MODULE_ENV}`, { cause });
  }
}
