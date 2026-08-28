// Placeholder origin on T3 Code's default port 3773.
//
// Scope note: this is NOT a T3 server. It exists so Phase 7's container
// wiring can be exercised against the right port number while Phase 8 does
// the real T3 HTTP/WebSocket integration work.
const { createServer } = require("node:http");

createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      placeholder: true,
      note: "T3 deep integration is planned for Phase 8",
    }),
  );
}).listen(3773, "127.0.0.1", () => {
  console.log("t3 placeholder ready on 127.0.0.1:3773");
});
