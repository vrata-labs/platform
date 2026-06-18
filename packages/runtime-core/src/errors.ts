export interface TelemetryEvent {
  code: string;
  severity: "info" | "warn" | "error";
}

export function createTelemetryEvent(code: string, severity: TelemetryEvent["severity"]): TelemetryEvent {
  return { code, severity };
}
