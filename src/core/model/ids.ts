/** Globally unique, collision-safe ids. Safe to generate on any peer without
 * coordination — a hard requirement for distributed collaboration. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}
