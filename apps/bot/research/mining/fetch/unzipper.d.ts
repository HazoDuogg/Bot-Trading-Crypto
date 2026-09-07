// Minimal ambient types for the `unzipper` package (no @types package published, and it's only a
// transitive hoisted dependency here, not a first-class one) — just enough surface for
// fetchBookTickerStressWeeks.ts's streaming single-entry use.
declare module 'unzipper' {
  export function ParseOne(regex?: RegExp, options?: unknown): NodeJS.ReadWriteStream;
  export const Open: {
    buffer(buffer: Buffer): Promise<{ files: Array<{ path: string; uncompressedSize: number; stream(): NodeJS.ReadableStream; buffer(): Promise<Buffer> }> }>;
    file(path: string): Promise<{ files: Array<{ path: string; uncompressedSize: number; stream(): NodeJS.ReadableStream; buffer(): Promise<Buffer> }> }>;
  };
}
