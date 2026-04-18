import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import OpenAI from "openai";
import sharp from "sharp";
import { createLogger } from "@summon/shared";

const log = createLogger("avatar-generation");

export interface AvatarGenerator {
  generateAndUploadAvatar(params: { agentId: string; prompt: string }): Promise<string>;
}

let cachedOpenAI: OpenAI | null = null;
let cachedS3: S3Client | null = null;

function getOpenAI(): OpenAI {
  if (!cachedOpenAI) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    cachedOpenAI = new OpenAI({ apiKey });
  }
  return cachedOpenAI;
}

function getS3(): S3Client {
  if (!cachedS3) {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error("R2 credentials are not fully configured");
    }
    cachedS3 = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return cachedS3;
}

function getBucket(): string {
  return process.env.R2_BUCKET || "memento";
}

function getPublicUrl(): string {
  const url = process.env.R2_PUBLIC_URL;
  if (!url) {
    throw new Error("R2_PUBLIC_URL is not set");
  }
  return url.replace(/\/+$/, "");
}

const PORTRAIT_BRIEF_SYSTEM = `You turn an AI agent's personality description (SOUL) into a short casting brief for a photorealistic LinkedIn-style headshot of the person who would embody that agent.

Output ONE paragraph, 50 to 90 words, covering: approximate age range, gender expression, ethnicity (pick plausibly — vary across briefs, avoid defaulting to one archetype), hair (color, length, style), face (expression, warmth level), attire (smart-casual or business, specific colors/textures), and overall vibe. Keep it specific and plausible — a real professional you might meet.

Do NOT invent a different name, do NOT describe accessories that read as childish (costumes, glitter, props), do NOT mention text/logos. Output the paragraph only — no preamble, no list, no quotes.`;

const IMAGE_STYLE_SUFFIX =
  "Professional LinkedIn-style headshot photograph, DSLR, 85mm lens, shallow depth of field, natural skin texture, soft studio lighting with gentle rim light, sharp focus on the eyes, head and shoulders composition framed from mid-chest up with the face occupying roughly 40% of the frame, direct eye contact with camera, neutral light-gray studio backdrop, smart-casual business attire, warm subtle closed-mouth smile, photorealistic, natural colors. " +
  "Negative: no illustration, no cartoon, no anime, no 3D render, no CGI, no painting, no stylization, no text, no watermark, no logo, no glasses unless specified, no costumes.";

export async function buildAvatarPrompt(name: string, soul: string): Promise<string> {
  const openai = getOpenAI();
  const soulSnippet = soul.trim().slice(0, 1000);
  const brief = await openai.chat.completions.create({
    model: "gpt-5.4",
    messages: [
      { role: "system", content: PORTRAIT_BRIEF_SYSTEM },
      { role: "user", content: `Agent name: ${name}\n\nSOUL:\n${soulSnippet}` },
    ],
  });
  const portraitBrief = brief.choices[0]?.message?.content?.trim();
  if (!portraitBrief) {
    throw new Error("Portrait brief generation returned empty content");
  }
  log.info(`Portrait brief for ${name}: ${portraitBrief}`);
  return `${portraitBrief}\n\n${IMAGE_STYLE_SUFFIX}`;
}

export function createRealAvatarGenerator(): AvatarGenerator {
  return {
    async generateAndUploadAvatar({ agentId, prompt }) {
      log.info(`Generating avatar for agent ${agentId}`);
      const openai = getOpenAI();
      const response = await openai.images.generate({
        model: "gpt-image-1",
        prompt,
        size: "1024x1024",
        n: 1,
      });

      const b64 = response.data?.[0]?.b64_json;
      if (!b64) {
        throw new Error("gpt-image-1 returned no b64_json payload");
      }

      const originalBytes = Buffer.from(b64, "base64");
      const resizedBytes = await sharp(originalBytes)
        .resize(400, 400, { fit: "cover" })
        .png({ compressionLevel: 9 })
        .toBuffer();

      const bucket = getBucket();
      const key = `pfps/${agentId}.png`;
      const s3 = getS3();
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: resizedBytes,
          ContentType: "image/png",
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );

      const publicUrl = `${getPublicUrl()}/${key}`;
      log.info(`Uploaded avatar for agent ${agentId} to ${publicUrl}`);
      return publicUrl;
    },
  };
}

export function createFakeAvatarGenerator(): AvatarGenerator {
  return {
    async generateAndUploadAvatar({ agentId }) {
      return `https://pub-example.test/pfps/${agentId}.png`;
    },
  };
}
