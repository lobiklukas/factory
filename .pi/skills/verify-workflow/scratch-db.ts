#!/usr/bin/env bun
// The workflow drive's own database (LOB-40): `up.sh` makes a fresh one per instance and `down.sh`
// drops it, so a drive always starts from no cards, no deliveries and no sessions — "a second
// delivery creates none" is about this run's delivery and nothing an earlier run left — and nothing
// is left behind when it is done.
//
//   bun scratch-db.ts create <name>   CREATE DATABASE, over TCP on DATABASE_URL's server
//   bun scratch-db.ts drop <name>     DROP DATABASE … WITH (FORCE), if it exists
//   bun scratch-db.ts exists <name>   prints `yes` or `no`
//
// The connection is the caller's DATABASE_URL (any database on that server; the statement names the
// scratch one). Only a name this skill mints is accepted — `<base>_wf_<digits>` — so a typo or a
// shell variable gone wrong cannot drop someone else's database.
import { SQL } from "bun";

const [mode, name] = process.argv.slice(2);
const SCRATCH = /^[a-z0-9_]+_wf_[0-9]+$/;
const url = process.env["DATABASE_URL"] ?? "";

if (url === "" || name === undefined || !SCRATCH.test(name)) {
  console.error(
    `usage: DATABASE_URL=… bun scratch-db.ts create|drop|exists <base>_wf_<digits> (got ${String(name)})`,
  );
  process.exit(2);
}

const sql = new SQL(url);
try {
  const found = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  if (mode === "exists") {
    console.log(found.length > 0 ? "yes" : "no");
  } else if (mode === "create") {
    if (found.length === 0) await sql.unsafe(`CREATE DATABASE "${name}"`);
    console.log(`created ${name}`);
  } else if (mode === "drop") {
    if (found.length > 0) {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    console.log(`dropped ${name}`);
  } else {
    console.error(`unknown mode ${String(mode)}: create, drop or exists`);
    process.exit(2);
  }
} finally {
  await sql.close();
}
