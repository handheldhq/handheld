export function maskApiKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "****";
  return trimmed.slice(0, 8) + "...";
}

export function maskUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.protocol + "//" + url.host + "/...";
  } catch {
    return trimmed.length <= 12 ? "****" : trimmed.slice(0, 12) + "...";
  }
}
