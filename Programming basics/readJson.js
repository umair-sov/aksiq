const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "firstOne.json");
const raw = fs.readFileSync(filePath, "utf8");
const jobs = JSON.parse(raw);

jobs.forEach((job, index) => {
  console.log(`Job ${index + 1}:`);
  console.log(`  Company: ${job["Company / Institution"]}`);
  console.log(`  Role: ${job["Job"]}`);
  console.log(`  Days: ${job["Days"]}`);
  console.log(`  Pay: ${job["Pay"]}`);
  console.log("");
});
