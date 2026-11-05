import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';

// ===========================================================================
// CUSTOMER LOGOS — served by the API itself.
//
// Logos have to be fetchable by a plain <img src> from three places, one of
// which (the login page) has nobody signed in yet: the login-page branding
// preview, the topbar chip, and the support workspace picker. Serving them
// from the API rather than a separate web server means branding works
// wherever the portal HTML happens to be hosted, with no nginx/Apache
// config to keep in sync.
//
// These routes are deliberately public and unauthenticated — a company logo
// is not a secret, and the login page needs it before any token exists.
// Nothing here touches the database or reveals anything beyond the image.
// ===========================================================================

const LOGO_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

export async function brandingRoutes(app: FastifyInstance) {
  const dir = process.env.LOGOS_DIR ?? '/opt/doyensys/logos';

  // GET /api/logos/:filename — public. e.g. /api/logos/petmate.png
  app.get('/api/logos/:filename', async (req, reply) => {
    const { filename } = req.params as { filename: string };

    // Path-traversal guard: only ever serve a bare filename out of the logos
    // directory. basename() strips any "../" a caller tries to sneak in, and
    // the resolved-prefix check is a second line of defence in case of odd
    // encodings.
    const safeName = path.basename(filename);
    const ext = path.extname(safeName).toLowerCase();
    const contentType = LOGO_CONTENT_TYPES[ext];
    if (!contentType) return reply.code(404).send({ error: 'Not found' });

    const fullPath = path.resolve(dir, safeName);
    if (!fullPath.startsWith(path.resolve(dir) + path.sep)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return reply.code(404).send({ error: 'Not found' });
    }

    // Logos change rarely; a day of browser caching keeps the topbar from
    // re-fetching on every page load. Bump the filename to force a refresh.
    reply.header('Cache-Control', 'public, max-age=86400');
    reply.type(contentType);
    return reply.send(fs.createReadStream(fullPath));
  });

  // GET /api/logos — lists what's actually in the logos directory, so you can
  // check a file landed where the API expects it without shell access.
  // (Fastify passes (request, reply) — the first argument is the request,
  // so it must not be named `reply`.)
  app.get('/api/logos', async (_req, _reply) => {
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => LOGO_CONTENT_TYPES[path.extname(f).toLowerCase()]);
      return { dir, files };
    } catch {
      return { dir, files: [], error: 'Logos directory does not exist yet' };
    }
  });
}
