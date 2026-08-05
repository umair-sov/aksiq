// pipeline/testDedup.js — throwaway test runner, not part of the pipeline itself
const { mergeSources } = require("./merge");
const { dedupRecords } = require("./dedup");

const sales = require("../fixtures/sales.json");
const ops = require("../fixtures/ops.json");
const support = require("../fixtures/support.json");

const { records } = mergeSources({ sales, ops, support });

dedupRecords(records)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error("dedup failed:", err.message);
  });