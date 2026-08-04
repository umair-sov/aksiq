// pipeline/testDedup.js — throwaway test runner, not part of the pipeline itself
const { mergeSources } = require("./merge");
const { dedupRecords } = require("./dedup");

const sales = require("../sales.json");
const ops = require("../ops.json");
const support = require("../support.json");

const merged = mergeSources({ sales, ops, support });

dedupRecords(merged)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error("dedup failed:", err.message);
  });