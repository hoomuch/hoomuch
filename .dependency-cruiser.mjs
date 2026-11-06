// Module boundaries, checked by `npm run deps` (part of `npm run check`). Most rules are ground
// rules from CONTRIBUTING.md, written as rules about imports. A finding names its rule; the comment
// on the rule says why it's there.
//
// Type-only imports (`import type`) vanish when the code is built, so most rules let them through.
// That's also why the rules are about direct imports, layer by layer, and none asks what a module
// can reach: with the swc parser (see `parser` below) reachability follows type-only imports too.
// Chained, the layer rules still close the gaps: pages import at runtime only pages, coss ui,
// SHARED_LIB and SHARED_META, and those two import only each other.

/** The helpers in src/lib that touch D1, env, mail or keys: server code only. */
const LIB_SERVER = 'auth|crypto|email-verification|flash|mail|rate-limit';
/** The rest of src/lib: helpers anything may use, the browser bundle and the adapters included. */
const SHARED_LIB = `^src/lib/(?!(${LIB_SERVER})\\.ts$)`;
/** Provider metadata and the read-model types: what pages import from outside src/views. */
const SHARED_META = '^src/(providers/(registry|types|warnings)|data/types)\\.ts$';
/** Provider adapter code: everything in src/providers/ but its metadata. */
const ADAPTER_CODE = '^src/providers/(?!(registry|types|warnings)\\.ts$)';

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A cycle of runtime imports makes the load order matter. Cycles through `import type` are fine: ' +
        'nothing runs.',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: "An import that doesn't resolve to a file or a package. k6's modules are built into k6.",
      from: {},
      to: { couldNotResolve: true, pathNot: '^k6(/|$)' },
    },
    {
      name: 'src-not-to-dev-dependencies',
      severity: 'error',
      comment:
        'The Worker and the browser bundle ship with `dependencies` only; `devDependencies` are for the ' +
        'build, the tests and the tools.',
      from: { path: '^src/' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'src-not-to-tooling',
      severity: 'error',
      comment: 'The app never imports the tests, the benchmarks or the scripts.',
      from: { path: '^src/' },
      to: { path: '^(test|bench|scripts)/' },
    },
    {
      name: 'adapters-are-pure',
      severity: 'error',
      comment:
        'Ground rule: adapters take an injected fetch and clock (ctx.fetch, ctx.now) and never touch D1, ' +
        'env, the sync engine or the UI. src/providers imports only src/providers and SHARED_LIB, ' +
        'types included.',
      from: { path: '^src/providers/' },
      to: { path: '^src/', pathNot: `^src/providers/|${SHARED_LIB}` },
    },
    {
      name: 'shared-lib-stays-pure',
      severity: 'error',
      comment:
        'The browser bundle and the adapters use these helpers, so at runtime they import only each ' +
        'other. A helper that needs D1, env, mail or keys belongs in LIB_SERVER.',
      from: { path: SHARED_LIB },
      to: { path: '^src/', pathNot: SHARED_LIB, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'shared-meta-stays-light',
      severity: 'error',
      comment:
        'Pages and the browser bundle import provider metadata (providers/registry.ts, types.ts, ' +
        'warnings.ts) and the read-model types (data/types.ts), so at runtime these import only each ' +
        'other and SHARED_LIB. Adapters are looked up in providers/adapters.ts.',
      from: { path: SHARED_META },
      to: { path: '^src/', pathNot: `${SHARED_META}|${SHARED_LIB}`, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'dashboard-reads-only-from-d1',
      severity: 'error',
      comment:
        'Ground rule: the dashboard reads only from D1. The read models never import adapter code or ' +
        'the sync engine; only the sync engine and services/connections.ts call adapters, through ' +
        'providers/adapters.ts. (Pages are held to browser-code-stays-off-the-server.)',
      from: { path: '^src/data/' },
      to: { path: `${ADAPTER_CODE}|^src/sync/engine\\.ts$`, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'browser-code-stays-off-the-server',
      severity: 'error',
      comment:
        'Pages render on the server and hydrate in the browser, and the browser bundle goes to every ' +
        'visitor. At runtime they import only pages, coss ui, SHARED_LIB and SHARED_META: never D1 ' +
        'queries, the sync engine, services, routes, adapters or LIB_SERVER. Their data comes in as ' +
        'props; types may come from anywhere.',
      from: { path: '^src/(client|views|components)/' },
      to: {
        path: '^src/',
        pathNot: `^src/(client|views|components)/|${SHARED_LIB}|${SHARED_META}`,
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'browser-code-not-to-node-builtins',
      severity: 'error',
      comment: "Pages run in the browser too, where node: modules don't exist.",
      from: { path: '^src/(client|views|components)/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'coss-ui-only-from-views',
      severity: 'error',
      comment:
        'Ground rule: UI comes from coss ui, and only views use it (wrapped in ' +
        'src/views/components/ui.tsx when hoomuch adds rules of its own).',
      from: { path: '^src/', pathNot: '^src/(views|components/ui)/' },
      to: { path: '^src/components/ui/' },
    },
    {
      name: 'coss-ui-stays-generic',
      severity: 'error',
      comment:
        'The coss ui components stay as the shadcn CLI writes them: they import npm packages, each other ' +
        'and src/lib/utils.ts, never hoomuch code.',
      from: { path: '^src/components/ui/' },
      to: { path: '^src/', pathNot: '^src/(components/ui/|lib/utils\\.ts$)' },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    // bench/.state and bench/results hold generated data and a checked-out copy of main. Declaration
    // files have no runtime imports, and swc can't parse ambient ones (`export const X: T;`).
    exclude: { path: ['^bench/(\\.state|results)/', '\\.d\\.[cm]?ts$'] },
    // TypeScript 7.0 has no compiler API for dependency-cruiser to parse with (it supports TypeScript
    // below 7), so it parses with swc instead. Once dependency-cruiser supports a stable TypeScript
    // 7.x, drop `parser` and the @swc/core devDependency.
    parser: 'swc',
    tsPreCompilationDeps: false,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
