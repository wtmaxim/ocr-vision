declare module "pdftoimg-js/browser" {
  export interface PdfToImgOptions {
    imgType?: "png" | "jpg";
    scale?: number;
    background?: string;
    intent?: "display" | "print" | "any";
    pages?:
      | "all"
      | "firstPage"
      | "lastPage"
      | number
      | number[]
      | { startPage: number; endPage: number };
    maxWidth?: number | null;
    maxHeight?: number | null;
    scaleForBrowserSupport?: boolean;
  }

  export function pdfToImg(
    src: string,
    options?: PdfToImgOptions
  ): Promise<string | string[]>;
}






