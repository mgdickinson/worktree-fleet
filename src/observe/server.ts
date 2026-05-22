import { spawn } from "node:child_process";
import http from "node:http";
import { buildFleetSnapshot } from "../core/fleet-snapshot.js";
import { observeHtml } from "./ui.js";

export interface ObserveServerOptions {
  cwd: string;
  host: string;
  port: number;
  intervalSeconds: number;
  refreshCurrent: boolean;
}

export interface ObserveServer {
  url: string;
  close(): Promise<void>;
}

export async function startObserveServer(options: ObserveServerOptions): Promise<ObserveServer> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${options.host}`);
    if (request.method !== "GET") {
      sendText(response, 405, "method not allowed");
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      sendHtml(response, observeHtml(Math.round(options.intervalSeconds * 1000)));
      return;
    }
    if (url.pathname === "/favicon.ico") {
      sendIcon(response);
      return;
    }
    if (url.pathname === "/api/snapshot") {
      try {
        const snapshot = buildFleetSnapshot({
          cwd: options.cwd,
          refreshCurrent: options.refreshCurrent
        });
        sendJson(response, snapshot);
      } catch (error) {
        sendJson(response, {
          error: error instanceof Error ? error.message : String(error)
        }, 500);
      }
      return;
    }
    sendText(response, 404, "not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://${options.host}:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

export function openBrowser(url: string): void {
  const command = browserCommand(url);
  if (!command) return;
  try {
    const child = spawn(command.command, command.args, {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {
    // The printed URL is the reliable launch path; opening a browser is best effort.
  }
}

function browserCommand(url: string): { command: string; args: string[] } | null {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

function sendHtml(response: http.ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

function sendJson(response: http.ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendIcon(response: http.ServerResponse): void {
  response.writeHead(204, {
    "cache-control": "max-age=86400"
  });
  response.end();
}

function sendText(response: http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}
