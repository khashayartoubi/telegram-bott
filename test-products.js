require("dotenv").config();

const products = require("./src/data/products");

console.table(
  products.map((product) => ({
    id: product.id,
    country: product.countryName,
    duration: product.duration,
    traffic: product.trafficLabel,
    price: product.price.toLocaleString("fa-IR"),
    inboundId: product.inboundId,
  })),
);

console.log("\nUser limit options:");
console.table(products.USER_LIMIT_OPTIONS);
