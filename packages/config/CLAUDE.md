# packages/config

Shared TypeScript and Biome configuration for every app and package (ADR 0001, 0011).

## Layout
- `biome.json`: formatter and lint rules, extended by the root `biome.json` (which only sets the files to check).
- `tsconfig/base.json`: strict compiler options for all code.
- `tsconfig/node.json`: Node ESM (`NodeNext`), for packages. `tsconfig/nest.json`: `node.json` plus legacy decorators and their metadata, for the API and the worker. `tsconfig/react.json`: DOM, JSX and bundler resolution without emit, for `packages/ui`, `apps/store` and `apps/admin` (each adds its own `types`).
- `test/tsconfig.test.ts`: guards the settings that must never be loosened.

## Rules
- A package's `tsconfig.json` extends one of these (`@vertex-digital/config/tsconfig/node.json`) and adds only paths and output options.
- Never loosen `strict`, `noUncheckedIndexedAccess` or a lint rule to make a check pass: fix the code. A rule that must differ for one app goes in an `overrides` entry here, with the reason.
- `useImportType` is off for `apps/api` and `apps/worker`: Nest injects by the runtime class named in a constructor, which a type-only import would erase. Keep that override.
- A new preset arrives with the first app that needs it, with a test case in `test/tsconfig.test.ts`.

## Checks
`pnpm verify packages/config/test/tsconfig.test.ts`.
