/**
 * Small HTTP helpers shared by the plugin's two browser-facing routes
 * (`/plugins/dsh-miaoda/preview` and `/plugins/dsh-miaoda/workbench`).
 *
 * Both routes are served by the harness `webServer` service on the GUI origin,
 * so they must behave like quiet local endpoints: same-origin only, JSON only,
 * no caching, and never throw back into the server.
 */

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Same-origin guard. A browser omits `Origin` on same-origin GETs, so an absent
 * header is accepted; anything else must match the request's own host.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {boolean}
 */
export function sameOrigin(req) {
  const origin = req?.headers?.origin;
  if (typeof origin !== 'string' || origin.trim() === '') return true;
  const host = req?.headers?.host;
  if (typeof host !== 'string' || host === '') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Write a JSON response once, tolerating a socket that already went away.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {Record<string, unknown>} value - body.
 * @returns {void}
 */
export function json(res, status, value) {
  if (!res || res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

/**
 * Write a binary response (the login QR image) with no caching.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {string} type - mime type.
 * @param {Buffer} body - bytes.
 * @returns {void}
 */
export function bytes(res, status, type, body) {
  if (!res || res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'content-type': type,
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Buffer and parse a small JSON request body.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {number} [limit] - max bytes.
 * @returns {Promise<Record<string, unknown>>}
 */
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > limit) {
        try {
          req.destroy();
        } catch {
          /* already gone */
        }
        reject(new Error('body-too-large'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (size === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('invalid-json'));
      }
    });
    req.on('error', reject);
  });
}
