import type { RuntimeCommand } from "./runtime-commands.js";

export type FrameLocomotionCommand = RuntimeCommand | { type: "confirm_interaction_target" };

export interface FrameLocomotionCommandHandlers {
  executeRuntimeCommands(commands: RuntimeCommand[]): void;
  confirmInteractionTarget(): void;
}

export function executeFrameLocomotionCommands(
  commands: FrameLocomotionCommand[],
  handlers: FrameLocomotionCommandHandlers
): void {
  const runtimeCommands: RuntimeCommand[] = [];
  const flushRuntimeCommands = () => {
    if (runtimeCommands.length > 0) {
      handlers.executeRuntimeCommands(runtimeCommands.splice(0));
    }
  };

  for (const command of commands) {
    if (command.type === "confirm_interaction_target") {
      flushRuntimeCommands();
      handlers.confirmInteractionTarget();
      continue;
    }
    runtimeCommands.push(command);
  }

  flushRuntimeCommands();
}
