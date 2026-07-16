# Hello world

Zero to API in under a minute, no database setup, no Docker, no scaffolding step:

```bash
npm install
npm start
```

Then (with the key printed at startup):

```bash
curl -X POST http://127.0.0.1:3000/v1/collections/todos/docs \
  -H "Authorization: Bearer <your key>" \
  -H "Content-Type: application/json" \
  -d '{"data": {"title": "Ship it"}, "publish": true}'

curl http://127.0.0.1:3000/v1/collections/todos/docs \
  -H "Authorization: Bearer <your key>"
```

Point an MCP-capable agent at `http://127.0.0.1:3000/mcp` with the same key and
it can discover the schema and manage todos on its own.
