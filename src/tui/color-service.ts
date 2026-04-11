export type ColorMode = "auto" | "always" | "never";

const VALID_COLOR_MODES: readonly ColorMode[] = ["auto", "always", "never"];

export function isValidColorMode(mode: string): mode is ColorMode {
  return VALID_COLOR_MODES.includes(mode as ColorMode);
}

export interface ColorOptions {
  mode?: ColorMode;
}

export interface ColorService {
  enabled: boolean;
  getMode: () => ColorMode;
  toggle: () => void;
  setMode: (mode: ColorMode) => void;
}

const NO_COLOR = process.env.NO_COLOR !== undefined;
const IS_TTY = process.stdout?.isTTY ?? false;

const checkEnvironment = (): boolean => {
  if (NO_COLOR) return false;
  if (!IS_TTY) return false;
  return true;
};

export function getEffectiveColor(): boolean {
  return checkEnvironment();
}

export function createColorService(options: ColorOptions = {}): ColorService {
  const { mode: initialMode = "auto" } = options;

  let currentMode = initialMode;

  const checkEnabled = (): boolean => {
    if (currentMode === "always") return true;
    if (currentMode === "never") return false;
    return checkEnvironment();
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