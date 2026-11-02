// server.js
const express = require("express");
const path = require("path");
const storesRouter = require("./routes/stores");
const debugCollectionsRouter = require("./routes/debug-collections"); // TEMPORARY — remove both debug lines once sites.json is confirmed

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use("/api/stores", storesRouter);
app.use("/api/debug-collections", debugCollectionsRouter); // TEMPORARY

app.listen(PORT, () => console.log(`Store map server running on port ${PORT}`));
