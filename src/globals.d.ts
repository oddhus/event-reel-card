declare const __VERSION__: string;

type CustomCardEntry = {
  type: string;
  name: string;
  description?: string;
  preview?: boolean;
  documentationURL?: string;
};

// oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
interface Window {
  customCards?: CustomCardEntry[];
}
