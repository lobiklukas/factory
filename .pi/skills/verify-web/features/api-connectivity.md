# Browser reaches the API

**Status:** passing

## Sub-features

- The API answers `GET /` with `"Hello Effect!"` (an Effect `HttpApi` group, not a static route)
- The response is reachable **from the dashboard's browser origin**, which is what proves the
  CORS configuration rather than merely proving the server is up
- The client's API base URL resolves to the instance under test (`VITE_SERVER_URL`)

## How to get to it (user POV)

It is not a clickable feature. It is the precondition every other dashboard feature depends on,
and it is the first thing to check when a card appears dead.

## Driving it with drive.mjs

`drive.mjs` runs the request inside the page:

```js
page.evaluate((apiUrl) => fetch(`${apiUrl}/`, { method: "GET" }), API_URL);
```

Running it in the page is the point: a `curl` from the shell bypasses the browser's origin and
would report success even when the dashboard's own requests are blocked by CORS. The check
asserts status 200 and records the body in `observed.json`.

Reachable surfaces for a human:

```sh
curl -s http://localhost:9100/      # "Hello Effect!"
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:9100/rpc -d '{}'
```

The second returns 500 for a malformed body. That confirms `/rpc` is mounted (a 404 would mean
it is not) but is not a behavioral proof of anything.

## Gotchas

- `ALLOWED_ORIGINS` on the API must name the web port. `up.sh` pairs them; changing one without
  the other produces a CORS failure that looks like a dead card in the UI.
- `VITE_SERVER_URL` is read as `import.meta.env.VITE_SERVER_URL` and Vite does inline it from
  `process.env` on startup. If you change it, restart the dev server — a page reload is not enough.
