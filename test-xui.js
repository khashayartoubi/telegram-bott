require("dotenv").config();

const { request } = require("./src/services/xui.service");

async function test() {
  try {
    console.log("Testing 3x-ui API...");

    const result = await request("panel/api/inbounds/list");

    if (result.success !== true) {
      throw new Error(result.msg || "API request failed");
    }

    console.log("API authentication successful!");

    for (const inbound of result.obj || []) {
      console.log({
        id: inbound.id,
        remark: inbound.remark,
        protocol: inbound.protocol,
        enabled: inbound.enable,
      });
    }
  } catch (error) {
    console.error("Test failed:", error.message);
  }
}

test();
