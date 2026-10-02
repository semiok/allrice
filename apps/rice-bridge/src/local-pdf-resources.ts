import type { RuntimeLocalPdfPins } from '@allrice/contracts';
import type { configureTrustedPdfReaderRuntime } from '@allrice/office-runtime/pdf-reader';

export interface FixedPdfResources {
  root: string;
  core: string;
  guardian: string;
  platform: 'macos-x64' | 'macos-arm64';
  pins: RuntimeLocalPdfPins;
}

// SEA's fixed-resource build plugin replaces this module. Source builds cannot
// advertise packaged native isolation merely because node_modules is present.
export function inspectFixedPdfResources(): FixedPdfResources {
  throw Error('PDF_FIXED_RUNTIME_REQUIRES_SEA');
}

export function loadFixedPdfResources(): {
  PDFParse: Parameters<typeof configureTrustedPdfReaderRuntime>[0]['PDFParse'];
  resourcesDirectory: string;
  root: string;
} {
  throw Error('PDF_FIXED_RUNTIME_REQUIRES_SEA');
}
