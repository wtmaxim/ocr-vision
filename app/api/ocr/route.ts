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
    return process.env.OPENROUTER_MODEL || "mistralai/mistral-small-3.2-24b-instruct:free";
  }
  return process.env.TOGETHER_VISION_MODEL || "meta-llama/Llama-4-Scout-17B-16E-Instruct";
}

export const runtime = "nodejs";

function buildSystemPrompt(targetLang: string, format: "markdown" | "json") {
  const shouldTranslate = targetLang && targetLang !== "auto";
  const languageDirective = shouldTranslate
    ? `Output language: ${targetLang}. Translate ALL textual content into ${targetLang}, including brand and product names, headings, labels, tables and lists. Do NOT mix languages. Preserve numbers, currency symbols, and layout semantics.`
    : "Output language: keep the original language; do NOT translate.";

  if (format === "json") {
    return [
      "You are a reliable, precise vision OCR engine.",
      "Goal: detect the document type and return STRICT JSON only (no extra text).",
      languageDirective,
      "Rules:",
      "- Return ONLY valid JSON (no prose, no code fences).",
      "- No hallucinations: omit unknown fields; use 'UNKNOWN' if unreadable.",
      "- Keys MUST be camelCase; values plain strings/numbers/arrays/objects.",
      "- Include language (BCP-47) and text in reading order.",
      "Suggested flexible schema (include only relevant keys):",
      "{",
      "  documentType: string,",
      "  language?: string,",
      "  title?: string,",
      "  text: string,",
      "  keyValues?: [{ key: string, value: string }],",
      "  sections?: [{ title?: string, keyValues?: [{ key: string, value: string }], paragraphs?: string[] }],",
      "  lists?: [{ ordered: boolean, items: string[] }],",
      "  tables?: [{ headers?: string[], rows: string[][] }],",
      "  entities?: [{ label: string, value: string }],",
      "  totals?: { currency?: string, subtotal?: number, tax?: number, tip?: number, total?: number },",
      "  parties?: { seller?: { name?: string, address?: string, vatId?: string }, buyer?: { name?: string, address?: string, vatId?: string } },",
      "  references?: { invoiceNumber?: string, orderNumber?: string, transactionId?: string }",
      "}",
      "Constraints:",
      "- Dates ISO when possible (YYYY-MM-DD); amounts as numbers (no currency symbol).",
      "- Preserve numbers, currency symbols in text where applicable.",
    ].join("\n");
  }

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
    const many = form.getAll("files[]");
    const targetLang = String(form.get("targetLang") || "auto");
    const inputFiles: File[] = [];
    if (single && single instanceof File) inputFiles.push(single);
    for (const f of many) if (f instanceof File) inputFiles.push(f);
    if (!inputFiles.length) {
      console.warn("/api/ocr: missing or invalid file(s) field");
      return new Response("Missing image file(s) (JPEG/PNG only)", { status: 400 });
    }
    for (const f of inputFiles) {
      if (!f.type?.startsWith("image/")) {
        console.warn("/api/ocr: invalid mime type", { type: f.type });
        return new Response("Only JPEG and PNG images are accepted (PDF must be converted client-side)", { status: 415 });
      }
    }

    // Vérifier la taille (limite de 4MB)
    const maxSize = 4 * 1024 * 1024; // 4MB
    const totalSize = inputFiles.reduce((s, f) => s + f.size, 0);
    if (totalSize > maxSize) {
      console.warn("/api/ocr: files too large", { totalSize, maxSize, count: inputFiles.length });
      return new Response(`Fichiers trop volumineux (${Math.round(totalSize / 1024 / 1024)}MB > 4MB).`, { status: 413 });
    }

    // Convertit les images en data URLs (PDF déjà converti côté client)
    const dataUrls: { dataUrl: string; mimeType: string; size: number }[] = [];
    for (const f of inputFiles) {
      const arrayBuffer = await f.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      const mimeType = f.type || "image/jpeg";
      dataUrls.push({ dataUrl: `data:${mimeType};base64,${base64}`, mimeType, size: f.size });
    }

    // Logs context (sans contenus sensibles)
    const provider = (process.env.OCR_PROVIDER || "together").toLowerCase();
    const model = resolveModel();
    const format = String(form.get("format") || "markdown") as "markdown" | "json";
    console.info("/api/ocr: request", { provider, model, format, files: dataUrls.map(d => ({ mimeType: d.mimeType, size: d.size })) });

    const system = buildSystemPrompt(targetLang, format);
    const translateHint = targetLang && targetLang !== "auto"
      ? `Target language: ${targetLang}. Translate ALL textual content into ${targetLang}. Preserve numbers, currency symbols, and layout semantics.`
      : "Target language: source language (no translation).";

    // Logs détaillés avant appel
    console.info("/api/ocr: prepare call", {
      systemPreview: system.slice(0, 180),
      messageKinds: ["text", ...dataUrls.map(() => "image")],
      images: dataUrls.map(d => ({ mimeType: d.mimeType })),
      temperature: 0.2,
    });

    let out;
    try {
      out = await generateText({
        model: aiClient(model),
        temperature: 0.1,
        maxSteps: 1,
        system,
        messages: [
          {
            role: "user",
          content: [
              { type: "text", text: format === "json" 
                ? `${translateHint} Analyze these page image(s) and return ONLY valid JSON following the schema and rules above.`
                : `${translateHint} Analyze these page image(s), extract text and structure, and return valid Markdown.` },
              ...dataUrls.map((d) => ({ type: "image" as const, image: d.dataUrl })),
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

    if (format === "json") {
      try {
        // Essayer de parser si le modèle renvoie déjà un JSON
        const parsed = JSON.parse(text);
        return Response.json(parsed);
      } catch {
        // Sinon encapsuler
        return Response.json({ content: text });
      }
    }

    const contentTypeHeader = "text/markdown; charset=utf-8";
    console.info("/api/ocr: success", { format: "markdown", length: text.length, contentType: contentTypeHeader });
    return new Response(text, { status: 200, headers: { "content-type": contentTypeHeader } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "unknown";
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("/api/ocr: failure", { message, stack });
    return new Response(`Erreur: ${message}`, { status: 500 });
  }
}

