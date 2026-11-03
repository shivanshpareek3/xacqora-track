// Phase H — Vercel serverless entry.
//
// Vercel's Node functions hand us the native node:http req/res, so the
// existing request handler is reused verbatim. `require('../server')` opens
// the DB handle (pg-native against the managed Postgres at DATABASE_URL).
//
// Serverless notes:
//  - the in-process ticker is off (server/index.js only setIntervals when it
//    is the entry point); Vercel Cron POSTs to /admin/tick with
//    XACQORA_TICK_SECRET (vercel.json), every 5 minutes, so webhook jobs,
//    Meta pulls, the daily backup and the Monday weekly summary all run.
//  - pg-native's prebuilt binary ships for the runtime Vercel uses; if a
//    platform change ever breaks it, `vercel build` logs the node-gyp fall
//    back and the pure-JS `pg` driver in package.json is the escape hatch.
module.exports = require('../server').handleRequest;
