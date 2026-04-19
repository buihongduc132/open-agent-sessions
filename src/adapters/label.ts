export function createLabel(entry: { agent: string; alias: string }): string {
  return `[${entry.agent}:${entry.alias}]`;
}
