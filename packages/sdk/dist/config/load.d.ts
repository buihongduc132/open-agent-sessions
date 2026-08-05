import { Config } from "./types";
export declare function loadConfigFromFile(path: string): Config;
export declare function parseConfigText(contents: string, sourcePath?: string): Config;
