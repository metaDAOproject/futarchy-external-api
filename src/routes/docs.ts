import { Router, type Request, type Response } from 'express';
import { openApiSpec } from '../openapi.js';

// Redoc renders /openapi.json client-side. Pinned version + Subresource
// Integrity, so a compromised or changed CDN file is refused by the browser.
const REDOC_SCRIPT = 'https://cdn.jsdelivr.net/npm/redoc@2.5.4/bundles/redoc.standalone.js';
const REDOC_SRI = 'sha384-w447zOpYfw/1Tv/5AK9NfHTlQIqE3RVR6KY62jCyy9zNDgO64cMwGGP1Fj0zJVf5';

const DOCS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Futarchy External API — Reference</title>
  </head>
  <body>
    <redoc spec-url="/openapi.json"></redoc>
    <script src="${REDOC_SCRIPT}" integrity="${REDOC_SRI}" crossorigin="anonymous"></script>
  </body>
</html>
`;

/** Machine-readable contract (OpenAPI 3.1) and a rendered reference page. Not versioned. */
export function createDocsRouter(): Router {
  const router = Router();

  router.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(openApiSpec);
  });

  router.get('/docs', (_req: Request, res: Response) => {
    res.type('html').send(DOCS_HTML);
  });

  return router;
}
