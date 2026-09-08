# Wire contract examples

`contracts.json` contains literal synthetic JSON, shared by client `contract-fixtures.test.ts` and server `app.test.js`. It is outside package source, exports and build output. Valid requests cross the real HTTP validation route; invalid requests must fail before any repository call. Responses pass the actual client parser and server contract schema; the public DTO crosses HTTP and the client schema.

These examples describe the wire shape, not repository behavior. HTTP repository doubles return only explicitly configured DTOs and track calls; every unconfigured operation throws. Real revision/conflict/tombstone/alias/statistics behavior is covered by the PostgreSQL tests mapped in `audit/postgres-tests.md`. NaN is a separate local client case because JSON cannot represent it.
