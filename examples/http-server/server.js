// Minimal demo origin for the http-server example. Plain node core, no deps:
// deliberately boring so failures are never about the example itself.
const { createServer } = require("node:http");

createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("hello from inside the container\n");
}).listen(3000, "127.0.0.1", () => {
  console.log("origin ready on 127.0.0.1:3000");
});
