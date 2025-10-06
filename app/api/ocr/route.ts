import { NextRequest } from "next/server";
import { togetherai as togetherDefault, createTogetherAI } from "@ai-sdk/togetherai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";

function createClient() {
  const provider = (process.env.OCR_PROVIDER || "together").toLowerCase();
  if (provider === "openrouter") {
    const apiKey = process.env.OPENROUTER_API_KEY || "";
    return createOpenRouter({ apiKey });
  }
  const apiKey = process.env.TOGETHER_AI_API_KEY || process.env.TOGETHER_API_KEY || "";
  const baseURL = "https://api.together.xyz/v1";
  if (!apiKey) {
    return togetherDefault;
  }
  return createTogetherAI({ apiKey, baseURL });
}

const aiClient = createClient();

function resolveModel() {
  if (process.env.OCR_MODEL) return process.env.OCR_MODEL;
  const provider = (process.env.OCR_PROVIDER || "together").toLowerCase();
  if (provider === "openrouter") {
    return process.env.OPENROUTER_MODEL || "meta-llama/llama-4-maverick:free";
  }
  return process.env.TOGETHER_VISION_MODEL || "meta-llama/Llama-4-Scout-17B-16E-Instruct";
}

export const runtime = "nodejs";

function buildSystemPrompt(targetLang: string) {
  const shouldTranslate = targetLang && targetLang !== "auto";
  const languageDirective = shouldTranslate
    ? `Output language: ${targetLang}. Translate ALL textual content into ${targetLang}, including brand and product names, headings, labels, tables and lists. Do NOT mix languages. Preserve numbers, currency symbols, and layout semantics.`
    : "Output language: keep the original language; do NOT translate.";
  return [
    "You are a reliable, precise vision OCR engine.",
    "Goal: accurately extract the text and structure from the image and return valid Markdown.",
    "General rules:",
    languageDirective,
    "- Do not hallucinate. If something is missing or unreadable, use 'UNKNOWN'.",
    "- Preserve the logical reading order (left → right, top → bottom).",
    "- Preserve case, numbers, dates, symbols, units, and punctuation.",
    "- For tables, render as proper Markdown tables with headers if present.",
    "- For lists, use Markdown lists (unordered or ordered).",
    "- For headings, use consistent Markdown levels (#, ##, ###).",
    "- Do not add explanations beyond OCR content.",
    "- Return only valid Markdown.",
  ].join("\n");
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      console.warn("/api/ocr: invalid content-type", { contentType });
      return new Response("Content-Type must be multipart/form-data", { status: 400 });
    }

    const form = await req.formData();
    const single = form.get("file");
    const targetLang = String(form.get("targetLang") || "auto");
    if (!single || !(single instanceof File)) {
      console.warn("/api/ocr: missing or invalid file field");
      return new Response("Missing image file (JPEG/PNG only)", { status: 400 });
    }
    const file = single as File;
    if (!file.type?.startsWith("image/") || (file.type !== "image/jpeg" && file.type !== "image/png")) {
      console.warn("/api/ocr: invalid mime type", { type: file.type });
      return new Response("Only JPEG and PNG images are accepted", { status: 415 });
    }

    // Vérifier la taille (limite de 4MB)
    const maxSize = 4 * 1024 * 1024; // 4MB
    if (file.size > maxSize) {
      console.warn("/api/ocr: file too large", { size: file.size, maxSize });
      return new Response(`Fichier trop volumineux (${Math.round(file.size / 1024 / 1024)}MB > 4MB).`, { status: 413 });
    }

    // Convertit l'image en data URL
    const arrayBuffer = await file.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const mimeType = file.type || "image/jpeg";
    const dataUrl = `data:${mimeType};base64,${base64}`;

    // Logs context (sans contenus sensibles)
    const provider = (process.env.OCR_PROVIDER || "openai").toLowerCase();
    const model = resolveModel();
    console.info("/api/ocr: request", { provider, model, format: "markdown", file: { mimeType, size: file.size } });

    const system = buildSystemPrompt(targetLang);
    const translateHint = targetLang && targetLang !== "auto"
      ? `Target language: ${targetLang}. Translate ALL textual content into ${targetLang}. Preserve numbers, currency symbols, and layout semantics.`
      : "Target language: source language (no translation).";

    // Logs détaillés avant appel
    console.info("/api/ocr: prepare call", {
      systemPreview: system.slice(0, 180),
      messageKinds: ["text", "image"],
      imageData: { mimeType, approxBase64Length: base64.length },
      temperature: 0.2,
    });

    let out;
    try {
      out = await generateText({
        model: aiClient(model),
        temperature: 0.2,
        system,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `${translateHint} Analyze this image, extract text and structure, and return valid Markdown.` },
              { type: "image", image: dataUrl },
            ],
          },
        ],
      });
    } catch (err: unknown) {
      const anyErr = err as { name?: string; message?: string; status?: number; data?: unknown; response?: { status?: number; data?: unknown }; cause?: { message?: string } };
      console.error("/api/ocr: provider call failed", {
        name: anyErr?.name,
        message: anyErr?.message,
        status: anyErr?.status,
        data: anyErr?.data ? (typeof anyErr.data === 'string' ? anyErr.data.slice(0, 500) : anyErr.data) : undefined,
        responseStatus: anyErr?.response?.status,
        responseData: anyErr?.response?.data ? (typeof anyErr.response.data === 'string' ? anyErr.response.data.slice(0, 500) : anyErr.response.data) : undefined,
        causeMessage: anyErr?.cause?.message,
      });
      throw err;
    }
    const text = out.text;

    // Toujours retourner du Markdown
    const contentTypeHeader = "text/markdown; charset=utf-8";
    console.info("/api/ocr: success", { format: "markdown", length: text.length, contentType: contentTypeHeader });
    return new Response(text, {
      status: 200,
      headers: { "content-type": contentTypeHeader },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "unknown";
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("/api/ocr: failure", { message, stack });
    return new Response(`Erreur: ${message}`, { status: 500 });
  }
}

