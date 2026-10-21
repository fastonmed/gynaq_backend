# GYNAEQ backend

Node.js HTTP server and JSON data storage for the GYNAEQ website. Requires Node.js 20 or later; no external packages are needed.

## Run

Clone the frontend repository alongside this repository as `../frontend`, then run:

```sh
npm start
```

Open http://localhost:4000. Set `PORT` to change the port or `PUBLIC_DIR` to an absolute frontend directory. Frontend API requests use the same origin.

The server creates `data/gynaeq-db.json` from `data/seed-data.json` on first start. The runtime database is ignored by Git. Customer enquiries, quotations, and service contracts are excluded from the initial seed.

Before public deployment, add authentication and authorization to administrative API routes. The imported server currently exposes data and write endpoints without authentication.

## Administrator access

Set `ADMIN_EMAIL=fastonmed@gmail.com` and a strong `ADMIN_PASSWORD` in Hostinger Node.js environment variables. Without a configured password, sign-in stays disabled and administrative writes return 401. Sessions last eight hours and expire when the server restarts. Public visitors can read the catalog and submit enquiries; other writes and private CRM data require sign-in.

## Website console

The website console manages products, inventory, categories, brands, media, enquiries, blog posts, pages, FAQs, reviews, site navigation, contact details and page SEO. `/api/admin/resources/*` and backups require an administrator session. `/api/content` only returns published editorial content.

Set `DATA_DIR` to a permanent absolute directory outside the deployment root in production. The JSON database and uploaded image files live there. The seed remains in the repository and is copied only when no runtime database exists. Writes use an atomic file rename. A single Node.js process is required for this JSON storage implementation. Uploaded raster images are limited to 1.5 MB and served from `/api/media/`.

Run `npm test` for isolated integration checks.
