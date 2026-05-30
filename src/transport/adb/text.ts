export function encodeAdbInputText(text: string): string {
  let encoded = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "%") {
      if (text[index + 1] === " ") {
        encoded += "%%s";
        index += 1;
        continue;
      }
      encoded += "%%";
      continue;
    }
    if (char === " ") {
      encoded += "%s";
      continue;
    }
    encoded += char;
  }

  return encoded;
}

export function quoteDeviceShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Android's `ShellCommand` base prints "No shell command implementation." (on
 * stdout, exit 0) when a `cmd <service> <subcommand>` is not implemented. On
 * API 31+ `cmd clipboard set/get` hits this path, so a caller that only treats
 * a thrown error as failure will silently report success and leak this message.
 * Detect it so the clipboard path can fall back / report honestly instead.
 */
export function isShellCommandUnsupported(output: string): boolean {
  return /no shell command implementation/i.test(output);
}
