declare module 'word-extractor' {
  export interface ExtractedDoc {
    getBody(): string;
    getHeaders(): string;
    getFootnotes(): string;
    getAnnotations(): string;
  }
  export default class WordExtractor {
    extract(input: Buffer | string): Promise<ExtractedDoc>;
  }
}
