/**
 * Work around an upstream Windows bug in `@lark-apaas/fullstack-cli` (and any
 * similar tool): it does `const p = require.resolve(id); await import(p)`, and
 * on Windows `p` is `C:\...` — modern Node rejects that with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME ("Received protocol 'c:'").
 *
 * The hook rewrites such a specifier to a file:// URL **only for ESM imports**.
 * CommonJS `require("C:\\...")` resolves natively and must be left alone:
 * rewriting it breaks every CJS caller (npm itself, for instance).
 *
 * Loaded via `NODE_OPTIONS=--import <file url>`.
 */
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const conditions = Array.isArray(context?.conditions) ? context.conditions : [];
    const esm = conditions.includes('import') && !conditions.includes('require');
    if (esm && typeof specifier === 'string' && WINDOWS_ABSOLUTE.test(specifier)) {
      return nextResolve(pathToFileURL(specifier).href, context);
    }
    return nextResolve(specifier, context);
  },
});
