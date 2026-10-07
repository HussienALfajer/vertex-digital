import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

/**
 * Documents every query parameter of a contract schema in OpenAPI, so the panel's generated client
 * knows a list's filters. `@Query({ schema })` validates them; Swagger does not read it.
 */
export function ApiQueryOf(schema: z.ZodObject) {
  // An empty registry inlines the schemas that carry an id, so each parameter stands alone.
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    metadata: z.registry(),
  }) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const required = new Set(json.required ?? []);
  return applyDecorators(
    ...Object.entries(json.properties ?? {}).map(([name, property]) =>
      ApiQuery({ name, required: required.has(name), schema: property }),
    ),
  );
}
