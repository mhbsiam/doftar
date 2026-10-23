export function validateName(name: string): string | null {
  if (!name) return "Type a name";
  if (name === "." || name === "..") return `"${name}" isn't a valid name`;
  if (name.includes("/") || name.includes(":")) {
    return "A name can't contain a slash (/) or colon (:)";
  }
  if (name.includes("\0")) return "A name can't contain a null character";
  if (new TextEncoder().encode(name).length > 255) return "That name is too long";
  return null;
}
