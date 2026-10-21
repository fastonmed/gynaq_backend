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
