const { mergeSources } = require("./merge");
const { dedupRecords } = require("./dedup");
const { synthesize } = require("./synthesize");

const sales = require("../fixtures/sales.json");
const ops = require("../fixtures/ops.json");
const support = require("../fixtures/support.json");

const { records, skipped } = mergeSources({ sales, ops, support });

dedupRecords(records)
  .then((dedupResult) => synthesize(dedupResult, skipped))
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((err) => console.error("pipeline failed:", err.message));