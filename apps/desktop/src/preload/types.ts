export type ThemeMode = "light" | "dark" | "system";

export interface StudioApi {
  platform: NodeJS.Platform;
  getApiBaseUrl: () => Promise<string>;
  adjustZoom: (action: "in" | "out" | "reset") => Promise<number>;
  onApiBaseUrl: (listener: (url: string) => void) => () => void;
  onBackendError: (listener: (message: string) => void) => () => void;
  getTheme: () => Promise<"light" | "dark">;
  setTheme: (theme: ThemeMode) => Promise<"light" | "dark">;
  onThemeChanged: (listener: (theme: "light" | "dark") => void) => () => void;
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
  openOutputsFolder: () => Promise<string>;
  openPath: (filePath: string) => Promise<string>;
  openOutputImage: (imageName: string) => Promise<string>;
  deleteOutputImage: (imageName: string) => Promise<void>;
  openOutputAudio: (audioName: string) => Promise<string>;
  revealOutputAudio: (audioName: string) => Promise<void>;
  deleteOutputAudio: (audioName: string) => Promise<void>;
  saveOutputAudio: (audioName: string) => Promise<string | null>;
  showImageInFolder: (filePath: string) => Promise<void>;
  pickReferenceImage: () => Promise<string | null>;
  pickTextModelFolder: () => Promise<string | null>;
  saveImageAs: (defaultName: string) => Promise<string | null>;
  writeImageFile: (targetPath: string, sourceUrl: string) => Promise<string>;
  copyText: (text: string) => Promise<void>;
  readFileAsDataUrl: (filePath: string) => Promise<string>;
  clearWebCache: () => Promise<void>;
}

declare global {
  interface Window {
    studio: StudioApi;
  }
}

export {};
