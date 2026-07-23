/**
 * Compile-time exhaustiveness guard for discriminated unions.
 *
 * Put `default: return assertNever(x)` at the end of a switch over a closed union (a ClientCommand,
 * a ServerEvent) and the compiler will flag the switch the moment a new member is added but not
 * handled, the value narrows to `never` only when every case is covered, so an unhandled variant is
 * a type error at exactly the site that must handle it. Without it, adding a wire command that the
 * dispatcher forgets compiles clean and silently drops the command at runtime.
 */
export function assertNever(x: never): never {
  throw new Error(`unhandled union member: ${JSON.stringify(x)}`);
}
