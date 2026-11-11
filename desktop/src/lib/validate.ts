/** Argument checks for every IPC call from the local screens. Each returns the value or throws. */

export class InvalidArgument extends Error {
  constructor(name: string) {
    super(`Invalid ${name}.`);
    this.name = 'InvalidArgument';
  }
}

/** App record ids: 16 to 40 lower-case letters and digits. */
export function id(value: unknown, name = 'id'): string {
  if (typeof value !== 'string' || !/^[a-z0-9]{16,40}$/.test(value)) throw new InvalidArgument(name);
  return value;
}

export function optionalId(value: unknown, name = 'id'): string | null {
  if (value === null || value === undefined) return null;
  return id(value, name);
}

export function text(value: unknown, name: string, max: number, min = 0): string {
  if (typeof value !== 'string' || value.length > max || value.length < min) throw new InvalidArgument(name);
  return value;
}

export function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new InvalidArgument(name);
  return value;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new InvalidArgument(name);
  return value as T;
}

/** A display name: 1 to 60 characters, no control characters, trimmed. */
export function displayName(value: unknown, name = 'name'): string {
  if (typeof value !== 'string') throw new InvalidArgument(name);
  const trimmed = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!trimmed || trimmed.length > 60 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new InvalidArgument(name);
  return trimmed;
}
