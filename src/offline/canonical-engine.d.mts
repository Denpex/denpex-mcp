export function runCanonicalOfflineDiagnosis(
  logs: string,
  options?: {
    telemetry?: Record<string, string>;
    codeContext?: Record<string, string>;
    topologyMap?: Record<string, string[]>;
  },
): Promise<Record<string, any>>;

export function canonicalOfflineEnvelope(outcome: Record<string, any>): Record<string, any>;
