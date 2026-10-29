import { createFolder } from "./tools/folderTool.js";

try {

  console.log("Testing folder creation...");

  const result = await createFolder("TestReports");

  console.log(result);

} catch (error) {

  console.error("Error:", error.message);

}