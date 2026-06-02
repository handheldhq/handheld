export function maskApiKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "****";
  return trimmed.slice(0, 8) + "...";
}
