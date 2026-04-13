import fs from "fs";
import path from "path";

// Find the monorepo root by walking up from cwd looking for data/ dir or pnpm-workspace.yaml
function findLogDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) || fs.existsSync(path.join(dir, "data"))) {
      return path.join(dir, "data");
    }
    dir = path.dirname(dir);
  }
  // Fallback: use cwd/data
  return path.join(process.cwd(), "data");
}

const LOG_DIR = findLogDir();
const LOG_FILE = path.join(LOG_DIR, "summon.log");

// Ensure log directory exists
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // Ignore — directory may already exist or cwd may differ
}

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, context: string, message: string, data?: unknown): string {
  let line = `${formatTimestamp()} [${level}] [${context}] ${message}`;
  if (data !== undefined) {
    try {
      const serialized = data instanceof Error
        ? `${data.message}\n${data.stack}`
        : typeof data === "string"
          ? data
          : JSON.stringify(data, null, 2);
      line += `\n  ${serialized}`;
    } catch {
      line += `\n  [unserializable data]`;
    }
  }
  return line;
}

function writeToFile(line: string) {
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // Fallback: if we can't write to the file, at least don't crash
  }
}

function log(level: LogLevel, context: string, message: string, data?: unknown) {
  const line = formatMessage(level, context, message, data);

  // Always write to file
  writeToFile(line);

  // Also write to console
  switch (level) {
    case "ERROR":
      console.error(line);
      break;
    case "WARN":
      console.warn(line);
      break;
    default:
      console.log(line);
      break;
  }
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  child(subContext: string): Logger;
}

export function createLogger(context: string): Logger {
  return {
    debug: (message, data) => log("DEBUG", context, message, data),
    info: (message, data) => log("INFO", context, message, data),
    warn: (message, data) => log("WARN", context, message, data),
    error: (message, data) => log("ERROR", context, message, data),
    child(subContext: string): Logger {
      return createLogger(`${context}:${subContext}`);
    },
  };
}
