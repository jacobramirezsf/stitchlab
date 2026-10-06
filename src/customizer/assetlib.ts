// The curated-library core lives in api/_lib/ so the serverless function can
// bundle it reliably; this re-export keeps the client/test import path.
export * from "../../api/_lib/assetlib";
