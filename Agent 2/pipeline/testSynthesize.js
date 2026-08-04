const { mergeSources } = require("./merge");
const { dedupRecords } = require("./dedup");
const { synthesize } = require("./synthesize");

const sales = require("../sales.json");
const ops = require("../ops.json");
const support = require("../support.json");

const merged = mergeSources({ sales, ops, support });

dedupRecords(merged)
  .then((dedupResult) => synthesize(dedupResult))
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((err) => console.error("pipeline failed:", err.message));