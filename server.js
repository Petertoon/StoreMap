// server.js
const express = require("express");
const path = require("path");
const storesRouter = require("./routes/stores");
const bizcardsRouter = require("./routes/bizcards");
const exchangeRouter = require("./routes/exchange");
const vehiclesRouter = require("./routes/vehicles");
const equipmentRouter = require("./routes/equipment");
const debugCollectionsRouter = require("./routes/debug-collections"); // TEMPORARY — remove both debug lines once sites.json is confirmed

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] })); // /stores, /bizcards, /exchange, /vehicles and /equipment serve their .html pages
app.use("/api/stores", storesRouter);
app.use("/api/bizcards", bizcardsRouter);
app.use("/api/exchange", exchangeRouter);
app.use("/api/vehicles", vehiclesRouter);
app.use("/api/equipment", equipmentRouter);
app.use("/api/debug-collections", debugCollectionsRouter); // TEMPORARY

app.listen(PORT, () => console.log(`Store map server running on port ${PORT}`));
