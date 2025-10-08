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
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [targetLang, setTargetLang] = useState<string>("auto");
  const [outputFormat, setOutputFormat] = useState<"markdown" | "json">("markdown");
  const [result, setResult] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const previewUrl = useMemo(() => {
    if (imageFile) return URL.createObjectURL(imageFile);
    return null;
  }, [imageFile]);

  const onDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    setResult("");
    if (file.type === "application/pdf") {
      setPdfFile(file);
      setImageFile(null);
      // Prévisualiser la première page du PDF
      try {
        const { pdfToImg } = await import("pdftoimg-js/browser");
        const fileUrl = URL.createObjectURL(file);
        const images = await pdfToImg(fileUrl, { 
          pages: "firstPage", 
          imgType: "jpg", 
          scale: 0.8 
        });
        URL.revokeObjectURL(fileUrl);
        if (images) {
          const response = await fetch(Array.isArray(images) ? images[0] : images);
          const blob = await response.blob();
          const previewFile = new File([blob], `${file.name}-page1.jpg`, { type: "image/jpeg" });
          setImageFile(previewFile);
        }
      } catch {
        // Ignore preview failure
      }
    } else if (file.type === "image/jpeg" || file.type === "image/png") {
      setImageFile(file);
      setPdfFile(null);
    }
  }, []);

  const onSelectFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    if (!file) return;
    setResult("");
    if (file.type === "application/pdf") {
      setPdfFile(file);
      setImageFile(null);
      // Prévisualiser la première page du PDF
      try {
        const { pdfToImg } = await import("pdftoimg-js/browser");
        const fileUrl = URL.createObjectURL(file);
        const images = await pdfToImg(fileUrl, { 
          pages: "firstPage", 
          imgType: "jpg", 
          scale: 1.0 
        });
        URL.revokeObjectURL(fileUrl);
        if (images) {
          const response = await fetch(Array.isArray(images) ? images[0] : images);
          const blob = await response.blob();
          const previewFile = new File([blob], `${file.name}-page1.jpg`, { type: "image/jpeg" });
          setImageFile(previewFile);
        }
      } catch {
        // Ignore preview failure
      }
    } else if (file.type === "image/jpeg" || file.type === "image/png") {
      setImageFile(file);
      setPdfFile(null);
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
        const maxDimension = 720; // Limite de dimension (plus petit pour accélérer)
        
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
        }, 'image/jpeg', 0.6);
      };
      
      img.src = URL.createObjectURL(file);
    });
  }, []);

  const runOcr = useCallback(async () => {
    if (!imageFile && !pdfFile) return;
    setLoading(true);
    setResult("");
    try {
      const originalType = imageFile ? (imageFile.type === "image/png" ? "png" : "jpg") : "pdf";
      window.umami?.track?.("ocr_start", { lang: targetLang, type: originalType });
      const form = new FormData();
      
      if (pdfFile) {
        // Convertir PDF en images côté client
        try {
          const { pdfToImg } = await import("pdftoimg-js/browser");
          const fileUrl = URL.createObjectURL(pdfFile);
          const images = await pdfToImg(fileUrl, { 
            pages: "all", 
            imgType: "jpg", 
            scale: 0.8 
          });
          URL.revokeObjectURL(fileUrl);
          
          if (Array.isArray(images)) {
            for (let i = 0; i < images.length; i++) {
              const response = await fetch(images[i]);
              const blob = await response.blob();
              const pageFile = new File([blob], `${pdfFile.name}-page${i + 1}.jpg`, { type: "image/jpeg" });
              const compressed = await compressImage(pageFile);
              form.append("files[]", compressed);
            }
          } else if (images) {
            const response = await fetch(images);
            const blob = await response.blob();
            const pageFile = new File([blob], `${pdfFile.name}-page1.jpg`, { type: "image/jpeg" });
            const compressed = await compressImage(pageFile);
            form.append("file", compressed);
          }
        } catch (err) {
          console.error("PDF conversion failed:", err);
          throw new Error("Failed to convert PDF to images");
        }
      } else if (imageFile) {
        const compressedFile = await compressImage(imageFile);
        form.append("file", compressedFile);
      }
      
      form.append("targetLang", targetLang);
      form.append("format", outputFormat);
      
      const res = await fetch("/api/ocr", { method: "POST", body: form });
      if (!res.ok) {
        const errText = await res.text();
        window.umami?.track?.("ocr_error", { lang: targetLang, type: originalType, code: res.status });
        throw new Error(errText || `HTTP ${res.status}`);
      }
      if (outputFormat === "json") {
        const data = await res.json();
        setResult(JSON.stringify(data, null, 2));
      } else {
        const text = await res.text();
        setResult(text);
      }
      window.umami?.track?.("ocr_success", { lang: targetLang, type: originalType });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "unknown";
      setResult(`Erreur: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [imageFile, pdfFile, compressImage, targetLang, outputFormat]);

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
      const response = await fetch("/example.jpg", { cache: "no-store" });
      if (!response.ok) return;
      const blob = await response.blob();
      const file = new File([blob], "example.jpg", { type: "image/jpeg" });
      setImageFile(file);
      setPdfFile(null);
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

  const importExamplePdf = useCallback(async () => {
    try {
      const response = await fetch("/example.pdf", { cache: "no-store" });
      if (!response.ok) return;
      const blob = await response.blob();
      const file = new File([blob], "example.pdf", { type: "application/pdf" });
      setPdfFile(file);
      setImageFile(null);
      
      // Prévisualiser la première page du PDF
      try {
        const { pdfToImg } = await import("pdftoimg-js/browser");
        const fileUrl = URL.createObjectURL(file);
        const images = await pdfToImg(fileUrl, { 
          pages: "firstPage", 
          imgType: "jpg", 
          scale: 0.8 
        });
        URL.revokeObjectURL(fileUrl);
        if (images) {
          const response = await fetch(Array.isArray(images) ? images[0] : images);
          const blob = await response.blob();
          const previewFile = new File([blob], `${file.name}-page1.jpg`, { type: "image/jpeg" });
          setImageFile(previewFile);
        }
      } catch {
        // Ignore preview failure
      }
      
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
              <div>
                <img src={previewUrl} alt="preview" className="mx-auto max-h-64 object-contain" />
                {pdfFile && (
                  <div className="text-xs text-gray-500 mt-2 text-center">
                    📄 PDF: {pdfFile.name} (preview: page 1)
                  </div>
                )}
              </div>
            ) : (
              <div className="text-gray-600">
                Drop a JPG/PNG image or PDF here, or click to select a file
                <div className="text-xs text-gray-500 mt-2">
                  Formats JPG, PNG and PDF accepted. Automatic compression for images.
                </div>
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              className="hidden"
              onChange={onSelectFile}
            />
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              className="rounded border px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200"
              type="button"
              onClick={importExample}
              title="Import example JPG from /public"
            >
              Example JPG
            </button>
            <button
              className="rounded border px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200"
              type="button"
              onClick={importExamplePdf}
              title="Import example PDF from /public"
            >
              Example PDF
            </button>
            <label className="text-sm text-gray-700">Output language</label>
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
            <label className="text-sm text-gray-700">Format</label>
            <select
              className="border rounded px-2 py-1"
              value={outputFormat}
              onChange={(e) => setOutputFormat(e.target.value as "markdown" | "json")}
              title="Output format"
            >
              <option value="markdown">Markdown</option>
              <option value="json">JSON</option>
            </select>
            <button
              className="ml-auto rounded bg-black text-white px-4 py-2 disabled:opacity-50"
              disabled={loading || (!imageFile && !pdfFile)}
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