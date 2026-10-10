declare const __VERSION__: string;

interface CustomCardEntry {
  type: string;
  name: string;
  description?: string;
  preview?: boolean;
  documentationURL?: string;
}

interface Window {
  customCards?: CustomCardEntry[];
}
