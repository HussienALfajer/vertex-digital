import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { ACCESS, type RouteAccess } from '../src/core/access/index.js';

/*
 * Guards for the conventions of ADR 0011 that the type checker cannot see. A failure here means
 * the code breaks a project rule, not that the test is wrong: fix the code, or change the ADR.
 */

const apiRoot = fileURLToPath(new URL('../', import.meta.url));
const srcDir = join(apiRoot, 'src');
const modulesDir = join(srcDir, 'modules');
const schemaDir = fileURLToPath(new URL('../../../packages/db/src/schema/', import.meta.url));

interface Route {
  name: string;
  path: string;
  access: RouteAccess | undefined;
}

const joinPath = (...parts: (string | undefined)[]) =>
  parts
    .flatMap((part) => (part ?? '').split('/'))
    .filter(Boolean)
    .join('/');

describe('every route declares who may call it', () => {
  let routes: Route[] = [];
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const controllers = [...moduleRef.get(ModulesContainer).values()].flatMap((module) =>
      [...module.controllers.values()].map((wrapper) => wrapper.metatype as Type),
    );
    routes = controllers.flatMap((controller) =>
      Object.getOwnPropertyNames(controller.prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => controller.prototype[name])
        .filter((handler) => typeof handler === 'function')
        .filter((handler) => Reflect.hasMetadata(METHOD_METADATA, handler))
        .map((handler) => ({
          name: `${controller.name}.${handler.name}`,
          path: joinPath(
            Reflect.getMetadata(PATH_METADATA, controller),
            Reflect.getMetadata(PATH_METADATA, handler),
          ),
          access: Reflect.getMetadata(ACCESS, handler) ?? Reflect.getMetadata(ACCESS, controller),
        })),
    );
    close = () => moduleRef.close();
  });
  afterAll(() => close?.());

  it('finds the routes it checks', () => {
    expect(routes.map((route) => route.path)).toEqual(
      expect.arrayContaining(['health', 'altcha/challenge']),
    );
  });

  it('marks each route with @Public, @CustomerRoute, @AdminRoute or @AdminSetupRoute', () => {
    expect(routes.filter((route) => !route.access).map((route) => route.name)).toEqual([]);
  });

  it('puts admin routes, and only admin routes, under /api/admin/', () => {
    const offenders = routes
      .filter((route) => {
        const admin = route.access?.kind === 'admin' || route.access?.kind === 'adminSetup';
        return admin !== /^admin(\/|$)/.test(route.path);
      })
      .map((route) => `${route.name} (${route.access?.kind} at /api/${route.path})`);
    expect(offenders).toEqual([]);
  });
});

interface SourceImport {
  file: string;
  specifier: string;
  names: string[];
  /** Everything the target exports: `import * as`, `export *`, a dynamic `import()`. */
  namespace: boolean;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Every import of a file, read by the TypeScript parser: static imports (named, default,
 * namespace, type-only), re-exports and dynamic `import()`, whatever the quotes.
 */
function importsOf(file: string, source = readFileSync(file, 'utf8')): SourceImport[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: SourceImport[] = [];
  const named = (elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]) =>
    elements.map((element) => (element.propertyName ?? element.name).text);
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      let names: string[] = [];
      let namespace = false;
      if (ts.isImportDeclaration(node)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) namespace = true;
        if (bindings && ts.isNamedImports(bindings)) names = named(bindings.elements);
        if (node.importClause?.name) names.push('default');
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        names = named(node.exportClause.elements);
      } else {
        namespace = true;
      }
      found.push({ file, specifier: node.moduleSpecifier.text, names, namespace });
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push({ file, specifier: node.arguments[0].text, names: [], namespace: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

describe('import reading', () => {
  it('finds every form of import the boundary rules must see', () => {
    const source = [
      "import Default, { a, type B as C } from '../other/a.js';",
      'import * as db from "@vertex-digital/db";',
      "export { d } from '../other/d.js';",
      "export * from '../other/e.js';",
      "const f = await import('../other/f.js');",
    ].join('\n');
    expect(importsOf('x.ts', source)).toEqual([
      { file: 'x.ts', specifier: '../other/a.js', names: ['a', 'B', 'default'], namespace: false },
      { file: 'x.ts', specifier: '@vertex-digital/db', names: [], namespace: true },
      { file: 'x.ts', specifier: '../other/d.js', names: ['d'], namespace: false },
      { file: 'x.ts', specifier: '../other/e.js', names: [], namespace: true },
      { file: 'x.ts', specifier: '../other/f.js', names: [], namespace: true },
    ]);
  });
});

const display = (file: string) => relative(apiRoot, file).split(sep).join('/');

/** The module folder a source file belongs to, or null outside `src/modules`. */
function moduleOf(file: string): string | null {
  const path = relative(modulesDir, file);
  return path.startsWith('..') ? null : (path.split(sep)[0] ?? null);
}

const moduleNames = readdirSync(modulesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const imports = sourceFiles(srcDir).flatMap((file) => importsOf(file));

describe('module boundaries', () => {
  it('finds the modules it checks', () => {
    expect(moduleNames).toEqual(
      expect.arrayContaining(['admin', 'audit', 'auth', 'health', 'notifications']),
    );
  });

  it('gives every module a public index.ts', () => {
    const missing = moduleNames.filter(
      (name) => !sourceFiles(join(modulesDir, name)).includes(join(modulesDir, name, 'index.ts')),
    );
    expect(missing).toEqual([]);
  });

  it('reaches a module from outside only through its index.ts', () => {
    const offenders = imports
      .filter(({ specifier }) => specifier.startsWith('.'))
      .filter(({ file, specifier }) => {
        const target = resolve(dirname(file), specifier);
        const targetModule = moduleOf(target);
        if (!targetModule || targetModule === moduleOf(file)) return false;
        return target !== join(modulesDir, targetModule, 'index.js');
      })
      .map(({ file, specifier }) => `${display(file)} -> ${specifier}`);
    expect(offenders).toEqual([]);
  });

  /**
   * Which API module owns the tables of each schema file in packages/db (null: no API module
   * does; the worker writes them). A new schema file must be added here, which forces the
   * ownership decision (docs/architecture.md, API modules).
   */
  const TABLE_OWNERS: Record<string, string | null> = {
    admin: 'admin',
    audit: 'audit',
    auth: 'auth',
    catalog: 'catalog',
    deposits: 'deposits',
    files: 'files',
    notifications: 'notifications',
    orders: 'orders',
    pricing: 'pricing',
    rates: 'rates',
    settings: 'settings',
    suppliers: 'suppliers',
    system: null,
    telegram: 'telegram',
    wallet: 'wallet',
  };

  const tablesBySchemaFile = new Map(
    readdirSync(schemaDir)
      .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
      .map((name) => {
        const source = readFileSync(join(schemaDir, name), 'utf8');
        const tables = [...source.matchAll(/export const (\w+) = pg(?:Table|Enum)\(/g)].map(
          (match) => match[1] as string,
        );
        return [basename(name, '.ts'), tables] as const;
      })
      // Files without tables (index.ts) hold no data to own; columns.ts holds shared enums.
      .filter(([file, tables]) => tables.length > 0 && file !== 'columns'),
  );

  it('knows the owner of every schema file', () => {
    expect([...tablesBySchemaFile.keys()].sort()).toEqual(Object.keys(TABLE_OWNERS).sort());
  });

  it('queries only the tables its own module owns', () => {
    const ownerOfTable = new Map(
      [...tablesBySchemaFile].flatMap(([file, tables]) =>
        tables.map((table) => [table, TABLE_OWNERS[file] ?? null] as const),
      ),
    );
    const offenders = imports
      .filter(({ specifier }) => specifier === '@vertex-digital/db')
      .flatMap(({ file, names }) =>
        names
          .filter((name) => ownerOfTable.has(name) && ownerOfTable.get(name) !== moduleOf(file))
          .map((name) => `${display(file)} uses ${name} (owned by ${ownerOfTable.get(name)})`),
      );
    expect(offenders).toEqual([]);
  });

  it('never imports all of @vertex-digital/db at once, which would hide the tables used', () => {
    const offenders = imports
      .filter(({ specifier, namespace }) => specifier === '@vertex-digital/db' && namespace)
      .map(({ file }) => display(file));
    expect(offenders).toEqual([]);
  });
});

describe('one admin, no staff (ADR 0016)', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  /** Code, tests and front ends; migrations keep their history and are left out. */
  const roots = ['apps', 'packages'].map((dir) => join(repoRoot, dir));
  const skipped = new Set(['node_modules', 'dist', 'coverage', '.next', '.turbo', 'migrations']);
  /**
   * Files that may contain the word: the test that the rename keeps the Phase 0 row (it names the
   * old tables), and the common-password data (a leaked password list, not code).
   */
  const allowed = new Set([
    'packages/db/src/admin-rename.test.ts',
    'packages/contracts/src/common-passwords.data.ts',
  ]);

  function codeFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (skipped.has(entry.name) || entry.name.startsWith('test-results')) return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return codeFiles(path);
      return /\.(ts|tsx|mts|mjs|json|css|html)$/.test(entry.name) ? [path] : [];
    });
  }

  it('leaves no staff identifier, table, permission or role in apps/ and packages/', () => {
    const self = fileURLToPath(import.meta.url);
    const offenders = roots
      .flatMap(codeFiles)
      .filter((file) => file !== self)
      .filter((file) => /staff|ROLE_PERMISSIONS|hasPermission/i.test(readFileSync(file, 'utf8')))
      .map((file) => relative(repoRoot, file).split(sep).join('/'))
      .filter((file) => !allowed.has(file));
    expect(offenders).toEqual([]);
  });
});
