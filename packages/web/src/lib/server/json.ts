export function parseJsonArray(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("Response was not a string array");
    }
    return parsed;
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      throw new Error("Failed to parse JSON array");
    }
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("Recovered JSON array was invalid");
    }
    return parsed;
  }
}

export function parseJsonObject<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Failed to parse JSON object");
    }
    return JSON.parse(match[0]) as T;
  }
}
