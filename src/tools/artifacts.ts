import { execFile } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import script from '../artifact-script.json';
import { toolText } from './util.js';

export function registerArtifactTools(server: McpServer): void {
  server.registerTool('inspect_gpu_artifact', {
    title: 'Inspect a GPU artifact locally',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Read-only local inspection of PyTorch Flight Recorder JSON rank dumps, CUDA memory snapshot JSON, Nsight SQLite, checkpoint candidates or aligned rank timing JSON. Requires Python 3; uses no network and never executes pickle or changes checkpoints. Pass the resulting JSON to diagnose_crash as logs to review or save it using your normal Denpex configuration.',
    inputSchema: {
      module: z.enum(['flight-recorder', 'memory-snapshot', 'nsight', 'checkpoints', 'stragglers']),
      path: z.string().min(1).max(4096).describe('Local artifact file or checkpoint root directory.'),
    },
  }, async ({ module, path }) => {
    try {
      const value = await new Promise<Record<string, unknown>>((resolve, reject) => {
        execFile(process.env.DENPEX_PYTHON || 'python', ['-c', script, module, path],
          { timeout: 30000, maxBuffer: 256000, windowsHide: true }, (error, stdout) => {
            try {
              const parsed = JSON.parse(stdout);
              if (parsed.denpexArtifactVersion !== 1 || parsed.module !== module) throw new Error('Unsupported artifact response');
              if (error && parsed.status !== 'INCOMPLETE') throw error;
              resolve(parsed);
            } catch { reject(new Error('Local inspection failed. Verify Python 3 and a supported artifact format and size.')); }
          });
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value,
        isError: value.status === 'INCOMPLETE' };
    } catch (error) {
      return toolText(error instanceof Error ? error.message : 'Artifact inspection failed.', true);
    }
  });
}
