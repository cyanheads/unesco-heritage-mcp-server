/**
 * @fileoverview Drives resource definitions the way the framework's resource
 * handler does: match the URI against the template (segments arrive as sent,
 * percent-escapes undecoded), parse the params through the definition's schema,
 * then call the handler with a mock context carrying the declared errors and
 * the request URI.
 * @module tests/fixtures/resource
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';

/** The slice of a resource definition the reader needs. */
interface ReadableResource {
  errors?: readonly { code: number; reason: string }[] | undefined;
  handler(params: never, ctx: never): unknown;
  params?: { parse(input: unknown): unknown } | undefined;
  uriTemplate: string;
}

/** Variables a `{name}` template captures from `uri`, or `undefined` when it does not match. */
export function matchUri(template: string, uri: string): Record<string, string> | undefined {
  const names: string[] = [];
  const pattern = template
    .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
    .replace(/\{(\w+)\}/g, (_whole, name: string) => {
      names.push(name);
      return '([^/]+)';
    });
  const match = new RegExp(`^${pattern}$`).exec(uri);
  if (!match) return;
  return Object.fromEntries(names.map((name, i) => [name, match[i + 1] as string]));
}

/**
 * Reads `uri` through the resource: variables from the template, params parse,
 * handler. Rejects with the params `ZodError` or the handler's thrown error.
 */
export async function readResource<T = Record<string, unknown>>(
  definition: ReadableResource,
  uri: string,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const variables = matchUri(definition.uriTemplate, uri);
  if (!variables) throw new Error(`URI ${uri} does not match ${definition.uriTemplate}`);
  const params = definition.params ? definition.params.parse(variables) : variables;
  const ctx = createMockContext({
    errors: definition.errors as never,
    uri: new URL(uri),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return (await definition.handler(params as never, ctx as never)) as T;
}
