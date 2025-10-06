"use client";

import { useCallback, useMemo, useRef, useState } from "react";

declare global {
  interface Window {
    umami?: {
      track?: (event: string, data?: Record<string, unknown>) => void;
    };
  }
}

export default function Home() {
  const [dragOver, setDragOver] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [targetLang, setTargetLang] = useState<string>("auto");
  const [result, setResult] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const previewUrl = useMemo(() => (imageFile ? URL.createObjectURL(imageFile) : null), [imageFile]);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && (file.type === "image/jpeg" || file.type === "image/png")) {
      setImageFile(file);
      setResult("");
    }
  }, []);

  const onSelectFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    if (!file) return;
    setResult("");
    if (file.type === "image/jpeg" || file.type === "image/png") {
      setImageFile(file);
    }
  }, []);

  // Fonction pour compresser une image
  const compressImage = useCallback((file: File): Promise<File> => {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const img = new Image();
      
      img.onload = () => {
        // Calculer les nouvelles dimensions pour maintenir le ratio
        let { width, height } = img;
        const maxDimension = 1200; // Limite de dimension
        
        if (width > height && width > maxDimension) {
          height = (height * maxDimension) / width;
          width = maxDimension;
        } else if (height > maxDimension) {
          width = (width * maxDimension) / height;
          height = maxDimension;
        }
        
        canvas.width = width;
        canvas.height = height;
        
        // Dessiner l'image redimensionnée
        ctx?.drawImage(img, 0, 0, width, height);
        
        // Convertir en blob avec compression
        canvas.toBlob((blob) => {
          if (blob) {
            const compressedFile = new File([blob], file.name, { type: 'image/jpeg' });
            resolve(compressedFile);
          } else {
            resolve(file); // Fallback
          }
        }, 'image/jpeg', 0.8);
      };
      
      img.src = URL.createObjectURL(file);
    });
  }, []);

  const runOcr = useCallback(async () => {
    if (!imageFile) return;
    setLoading(true);
    setResult("");
    try {
      const originalType = imageFile.type === "image/png" ? "png" : "jpg";
      window.umami?.track?.("ocr_start", { lang: targetLang, type: originalType });
      const form = new FormData();
      
      
      if (imageFile) {
        const compressedFile = await compressImage(imageFile);
        form.append("file", compressedFile);
      }
      form.append("targetLang", targetLang);
      
      const res = await fetch("/api/ocr", { method: "POST", body: form });
      if (!res.ok) {
        const errText = await res.text();
        window.umami?.track?.("ocr_error", { lang: targetLang, type: originalType, code: res.status });
        throw new Error(errText || `HTTP ${res.status}`);
      }
      const text = await res.text();
      setResult(text);
      window.umami?.track?.("ocr_success", { lang: targetLang, type: originalType });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "unknown";
      setResult(`Erreur: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [imageFile, compressImage, targetLang]);

  const copyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(result || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }, [result]);

  const importExample = useCallback(async () => {
    try {
      const candidates = [
        "/example.jpg",
      ];
      let response: Response | null = null;
      let chosen: string | null = null;
      for (const path of candidates) {
        const r = await fetch(path, { cache: "no-store" });
        if (r.ok) {
          response = r;
          chosen = path;
          break;
        }
      }
      if (!response || !chosen) return;
      const blob = await response.blob();
      const inferredType = blob.type || (chosen.endsWith(".png") ? "image/png" : "image/jpeg");
      const file = new File([blob], chosen.replace("/", ""), { type: inferredType });
      setImageFile(file);
      setResult("");
      if (inputRef.current) {
        const dt = new DataTransfer();
        dt.items.add(file);
        inputRef.current.files = dt.files;
      }
    } catch {
      // silencieux
    }
  }, []);

  

  return (
    <div className="font-sans min-h-screen p-6 sm:p-10">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
        <div>
          <h1 className="text-xl font-semibold mb-4">OCR Vision</h1>
          <div
            className={
              "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer " +
              (dragOver ? "border-blue-500 bg-blue-50" : "border-gray-300")
            }
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
          >
            {previewUrl ? (
              <img src={previewUrl} alt="preview" className="mx-auto max-h-64 object-contain" />
            ) : (
              <div className="text-gray-600">
                Drop a JPG/PNG image here, or click to select a file
                <div className="text-xs text-gray-500 mt-2">
                  Formats JPG and PNG accepted. Automatic compression to optimize OCR.
                </div>
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              onChange={onSelectFile}
            />
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              className="rounded border px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200"
              type="button"
              onClick={importExample}
              title="Import example from /public"
            >
              Example
            </button>
            <label className="text-sm text-gray-700">Langue</label>
            <select
              className="border rounded px-2 py-1"
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              title="Output language"
            >
              <option value="auto">Auto (original)</option>
              <option value="en">English</option>
              <option value="fr">French</option>
              <option value="es">Español</option>
              <option value="de">Deutsch</option>
              <option value="it">Italiano</option>
              <option value="pt">Português</option>
              <option value="nl">Nederlands</option>
              <option value="ja">Japanese</option>
              <option value="zh">Chinese</option>
            </select>
            <button
              className="ml-auto rounded bg-black text-white px-4 py-2 disabled:opacity-50"
              disabled={loading || !imageFile}
              onClick={runOcr}
            >
              {loading ? "Analyse…" : "Analyse"}
            </button>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-medium">Result</h2>
            <button
              className="rounded border px-3 py-1 text-sm disabled:opacity-50"
              onClick={copyToClipboard}
              disabled={!result}
              title="Copy to clipboard"
            >
              {copied ? "Copied!" : "Copy to clipboard"}
            </button>
          </div>
          <div className="border rounded-lg p-4 min-h-[300px] bg-white whitespace-pre-wrap overflow-auto font-mono text-sm">
            {result || (loading ? "Analysing..." : "No result yet.")}
          </div>
        </div>
      </div>
    </div>
  );
}