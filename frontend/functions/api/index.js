// Site API, served at /api/* (see the redirect in netlify.toml).
// Add new endpoints by adding a route to `routes` below.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PATTERN_DIR = path.join(__dirname, "data", "patterns");
const PATTERN_LIST = JSON.parse(fs.readFileSync(path.join(PATTERN_DIR, "_index_.json"), "utf8"));

const text = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
  body,
});

// GET /api/pattern        -> a random Game of Life pattern (RLE)
// GET /api/pattern/<name> -> a specific pattern, 404 if not in the index
const fetchPattern = (name) => {
  if (name === undefined) {
    const random = PATTERN_LIST[crypto.randomInt(PATTERN_LIST.length)];
    return text(200, fs.readFileSync(path.join(PATTERN_DIR, random), "utf8"), { "Cache-Control": "no-store" });
  }
  if (!PATTERN_LIST.includes(name)) return text(404, "Not Found");
  return text(200, fs.readFileSync(path.join(PATTERN_DIR, name), "utf8"), { "Cache-Control": "public, max-age=86400" });
};

const routes = [
  { pattern: /^\/pattern(?:\/([^/]+))?\/?$/, handler: fetchPattern },
];

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") return text(405, "Method Not Allowed");

  // event.path is /api/... when reached through the redirect, /.netlify/functions/api/... when called directly
  const route = event.path.replace(/^\/(?:\.netlify\/functions\/)?api/, "") || "/";
  for (const { pattern, handler } of routes) {
    const match = route.match(pattern);
    if (!match) continue;
    try {
      return handler(...match.slice(1).map((param) => (param === undefined ? param : decodeURIComponent(param))));
    } catch (error) {
      if (error instanceof URIError) return text(400, "Bad Request");
      throw error;
    }
  }
  return text(404, "Not Found");
};
