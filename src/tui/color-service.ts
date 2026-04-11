export type ColorMode = "auto" | "always" | "never";

export interface ColorOptions {
  mode?: ColorMode;
}

export interface ColorService {
  enabled: boolean;
  getMode: () => ColorMode;
  toggle: () => void;
  setMode: (mode: ColorMode) => void;
}

export function createColorService(options: ColorOptions = {}): ColorService {
  const { mode: initialMode = "auto" } = options;

  let currentMode = initialMode;

  // Check environment for effective color
  const checkEnabled = (): boolean => {
    if (currentMode === "always") return true;
    if (currentMode === "never") return false;
    
    // Auto mode: check NO_COLOR env var and TTY
    if (process.env.NO_COLOR) return false;
    
    // Check TTY status
    if (process.stdout && !process.stdout.isTTY) {
      return false;
    }
    
    return true;
  };

  return {
    get enabled() {
      return checkEnabled();
    },

    getMode() {
      return currentMode;
    },

    toggle() {
      if (currentMode === "auto") {
        currentMode = "always";
      } else if (currentMode === "always") {
        currentMode = "never";
      } else {
        currentMode = "auto";
      }
    },

    setMode(mode: ColorMode) {
      currentMode = mode;
    },
  };
}

export function getEffectiveColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.stdout && !process.stdout.isTTY) return false;
  return true;
}