import fs from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** Serves files from `root`. Returns false when there is no such file. */
export async function serveStatic(req, res, pathname, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.resolve(root, '.' + rel);
  // Refuse anything that escapes the public folder (for example /../../etc/passwd).
  if (file !== root && !file.startsWith(root + path.sep)) return false;

  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    const body = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  } catch {
    return false;
  }
}
