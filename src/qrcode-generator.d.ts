declare module "qrcode-generator" {
  interface QRCode {
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
    createSvgTag(opts?: { cellSize?: number; margin?: number; scalable?: boolean }): string;
  }
  function qrcode(typeNumber: number, errorCorrectionLevel: "L" | "M" | "Q" | "H"): QRCode;
  export default qrcode;
}
