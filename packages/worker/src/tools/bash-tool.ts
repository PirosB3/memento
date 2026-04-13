import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import type { AgentTool } from "../../pi-types.js";

export function createBashTool(cwd: string): AgentTool {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Run a shell command. Use this for any task that requires running commands: web browsing (bb search, bb fetch, browse), curl APIs, run scripts, parse data with jq, do math with python3, etc.",
    parameters: Type.Object({
      command: Type.String({ description: "The shell command to execute" }),
    }),
    execute: async (_toolCallId, params, signal) => {
      const p = params as { command: string };
      return new Promise((resolve) => {
        const proc = spawn("bash", ["-c", p.command], {
          cwd,
          timeout: 120_000,
          env: { ...process.env },
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
          // Truncate at 50KB
          if (stdout.length > 50_000) {
            stdout = stdout.slice(0, 50_000) + "\n...(truncated)";
            proc.kill();
          }
        });

        proc.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
          if (stderr.length > 50_000) {
            stderr = stderr.slice(0, 50_000) + "\n...(truncated)";
          }
        });

        if (signal) {
          signal.addEventListener("abort", () => proc.kill(), { once: true });
        }

        proc.on("close", (code) => {
          const output = [
            stdout ? `stdout:\n${stdout}` : "",
            stderr ? `stderr:\n${stderr}` : "",
            `exit code: ${code}`,
          ]
            .filter(Boolean)
            .join("\n\n");

          resolve({
            content: [{ type: "text" as const, text: output }],
            details: { exitCode: code },
          });
        });

        proc.on("error", (err) => {
          resolve({
            content: [
              { type: "text" as const, text: `Command failed: ${err.message}` },
            ],
            details: { error: true },
          });
        });
      });
    },
  };
}
