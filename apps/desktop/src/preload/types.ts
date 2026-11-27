export type ThemeMode = "light" | "dark" | "system";
export type BackendFailureStage = "startup" | "running";
export interface BackendFailure {
  message: string;
  stage: BackendFailureStage;
}

export interface WorkspaceList {
  active: string;
  error?: string;
  items: Array<{ id: string; name: string }>;
}

export interface WorkspaceBackupPreview {
  token: string;
  name: string;
  createdAt: string;
  fileCount: number;
  size: number;
}

export interface StudioApi {
  hasWorkspaceSeed?: boolean;
  platform: NodeJS.Platform;
  architecture?: string;
  appVersion?: string;
  getApiBaseUrl: () => Promise<string>;
  retryBackend?: () => Promise<void>;
  adjustZoom: (action: "in" | "out" | "reset") => Promise<number>;
  onApiBaseUrl: (listener: (url: string) => void) => () => void;
  onBackendError: (listener: (message: string, stage?: BackendFailureStage) => void) => () => void;
  getTheme: () => Promise<"light" | "dark">;
  setTheme: (theme: ThemeMode) => Promise<"light" | "dark">;
  onThemeChanged: (listener: (theme: "light" | "dark") => void) => () => void;
  minimizeWindow: () => Promise<void>;
  openApplicationMenu?: (left: number, bottom: number) => Promise<void>;
  toggleMaximizeWindow: () => Promise<boolean>;
  onWindowMaximizedChanged: (listener: (maximized: boolean) => void) => () => void;
  closeWindow: () => Promise<void>;
  openOutputsFolder: () => Promise<string>;
  openPath: (filePath: string) => Promise<string>;
  openOutputImage: (imageName: string) => Promise<string>;
  deleteOutputImage: (imageName: string) => Promise<void>;
  openOutputAudio: (audioName: string) => Promise<string>;
  revealOutputAudio: (audioName: string) => Promise<void>;
  deleteOutputAudio: (audioName: string) => Promise<void>;
  saveOutputVideo: (name: string) => Promise<string | null>;
  saveOutputAudio: (audioName: string) => Promise<string | null>;
  showImageInFolder: (filePath: string) => Promise<void>;
  pickReferenceImage: () => Promise<string | null>;
  pickLoraFiles: () => Promise<string[]>;
  pickTextModelFolder: () => Promise<string | null>;
  pickGgufFiles: () => Promise<string[]>;
  pickCustomImageModelFolder: () => Promise<string | null>;
  saveImageAs: (defaultName: string) => Promise<string | null>;
  writeImageFile: (targetPath: string, sourceUrl: string) => Promise<string>;
  saveChatTranscript: (title: string, markdown: string) => Promise<boolean>;
  copyText: (text: string) => Promise<void>;
  readFileAsDataUrl: (filePath: string) => Promise<string>;
  saveWorkspaceBackup: (snapshot: string) => Promise<boolean>;
  listWorkspaces: () => Promise<WorkspaceList>;
  chooseWorkspaceBackup: () => Promise<WorkspaceBackupPreview | null>;
  restoreWorkspaceBackup: (token: string) => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>;
  readWorkspaceSeed: () => Promise<string | null>;
  finishWorkspaceSeed: () => Promise<void>;
  returnFromFailedRestore: () => Promise<void>;
  clearWebCache: () => Promise<void>;
}

declare global {
  interface Window {
    studio: StudioApi;
  }
}

export {};
