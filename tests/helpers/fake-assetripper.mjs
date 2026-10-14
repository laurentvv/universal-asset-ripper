// Stand-in for AssetRipper.GUI.Free in headless mode, run as a node script by the tests.
// FAKE_AR_LOG: file receiving one JSON line per event. FAKE_AR_MODE: ok | never-listen | exit-early | export-500
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const log = process.env.FAKE_AR_LOG;
const mode = process.env.FAKE_AR_MODE ?? "ok";
const append = (o) => log && fs.appendFileSync(log, JSON.stringify(o) + "\n");

append({ event: "start", args, pid: process.pid });

if (mode === "exit-early") {
  console.error("boom: cannot start the web server");
  process.exit(3);
} else if (mode === "never-listen") {
  setInterval(() => {}, 1000);
} else {
  const port = Number(args[args.indexOf("--port") + 1]);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = Object.fromEntries(new URLSearchParams(body));
      append({ event: "request", method: req.method, url: req.url, contentType: req.headers["content-type"], form });
      if (req.method === "GET") {
        res.writeHead(200);
        res.end("ok");
        return;
      }
      if (req.url === "/LoadFolder" || req.url === "/LoadFile") {
        res.writeHead(302, { location: "/" });
        res.end();
        return;
      }
      if (req.url === "/Export/UnityProject") {
        if (mode === "export-500") {
          res.writeHead(500);
          res.end("export exploded");
          return;
        }
        const assets = path.join(form.Path, "ExportedProject", "Assets");
        fs.mkdirSync(assets, { recursive: true });
        fs.writeFileSync(path.join(assets, "hello.txt"), "hi");
        fs.writeFileSync(path.join(form.Path, "ExportedProject", "ProjectSettings.asset"), "x");
        res.writeHead(302, { location: "/" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  server.listen(port, "127.0.0.1");
}
