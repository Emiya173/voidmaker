export type ShellPage = "chat" | "desktop" | "work" | "history" | "settings" | "diagnostics";
export type TrayAction =
  | Readonly<{ type: "toggle" }>
  | Readonly<{ type: "open"; page: ShellPage }>
  | Readonly<{ type: "stop" }>;
export type ShellEvent =
  | { type: "shell_visibility"; action: "toggle" }
  | { type: "shell_visibility"; action: "show"; page: ShellPage };
