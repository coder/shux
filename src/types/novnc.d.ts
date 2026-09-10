declare module "@novnc/novnc/lib/rfb" {
  interface RFBOptions {
    /** WebSocket protocols to use */
    wsProtocols?: string | string[];
    /** Shared mode (allows multiple connections) */
    shared?: boolean;
    /** Credentials for authentication */
    credentials?: {
      username?: string;
      password?: string;
      target?: string;
    };
    /** Repeat the connection if it is dropped */
    repeaterID?: string;
  }

  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);

    // Properties
    background: string;
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    qualityLevel: number;
    compressionLevel: number;
    capabilities: { power: boolean };

    // Methods
    disconnect(): void;
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    focus(): void;
    blur(): void;
    machineShutdown(): void;
    machineReboot(): void;
    machineReset(): void;
    clipboardPasteFrom(text: string): void;

    // Events
    addEventListener(type: "connect", listener: (e: CustomEvent) => void): void;
    addEventListener(
      type: "disconnect",
      listener: (e: CustomEvent<{ clean: boolean }>) => void
    ): void;
    addEventListener(
      type: "credentialsrequired",
      listener: (e: CustomEvent<{ types: string[] }>) => void
    ): void;
    addEventListener(
      type: "securityfailure",
      listener: (e: CustomEvent<{ status: number; reason: string }>) => void
    ): void;
    addEventListener(type: "clipboard", listener: (e: CustomEvent<{ text: string }>) => void): void;
    addEventListener(type: "bell", listener: (e: CustomEvent) => void): void;
    addEventListener(
      type: "desktopname",
      listener: (e: CustomEvent<{ name: string }>) => void
    ): void;
    addEventListener(
      type: "capabilities",
      listener: (e: CustomEvent<{ capabilities: { power: boolean } }>) => void
    ): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  }
}
