// server.ts
import { spawn, ChildProcess } from "child_process";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { pathToFileURL, fileURLToPath } from "url";
import { readFileSync, writeFileSync } from "fs";

const ROOT_PATH = "/Users/drew/programs/instant/server";
const PORT = 3000;

class LSPClient {
  private process: ChildProcess;
  private messageId = 1;
  private pending = new Map<number, { resolve: Function; reject: Function }>();
  private buffer = "";
  private initialized = false;

  constructor(rootPath: string) {
    this.process = spawn("clojure-lsp", [], {
      cwd: rootPath,
    });

    this.process.stdout!.on("data", (chunk) => this.onData(chunk));
    this.process.stderr!.on("data", (chunk) =>
      console.error("[lsp stderr]", chunk.toString()),
    );
    this.process.on("exit", (code) => console.log("[lsp exit]", code));
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString();

    while (true) {
      const headerMatch = this.buffer.match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!headerMatch) break;

      const contentLength = parseInt(headerMatch[1]!, 10);
      const headerLength = headerMatch[0].length;

      if (this.buffer.length < headerLength + contentLength) break;

      const body = this.buffer.slice(
        headerLength,
        headerLength + contentLength,
      );
      this.buffer = this.buffer.slice(headerLength + contentLength);

      const msg = JSON.parse(body);

      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(msg.error);
        } else {
          resolve(msg.result);
        }
      } else if (msg.method && msg.id !== undefined) {
        // Request from server - needs a response
        console.log("[lsp request]", msg.method);
        this.handleServerRequest(msg.id, msg.method, msg.params);
      } else if (msg.method) {
        // Notification from server (no response needed)
        console.log("[lsp]", msg.method, msg.params?.message || "");
      }
    }
  }

  private respond(id: number, result: any): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    this.process.stdin!.write(frame);
  }

  private handleServerRequest(id: number, method: string, params: any): void {
    // Handle requests from the LSP server
    if (method === "workspace/applyEdit") {
      // Acknowledge the edit request - we apply edits ourselves from the command result
      this.respond(id, { applied: true });
    } else if (method === "window/workDoneProgress/create") {
      // Acknowledge progress token creation
      this.respond(id, null);
    } else {
      // Unknown request - respond with null
      console.log("[lsp] unknown request:", method);
      this.respond(id, null);
    }
  }

  private send(method: string, params: any): Promise<any> {
    const id = this.messageId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    this.process.stdin!.write(frame);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.send("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(ROOT_PATH).href,
      capabilities: {},
    });

    // Send initialized notification (no response expected)
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    });
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    this.process.stdin!.write(frame);

    this.initialized = true;
    console.log("[lsp] initialized");
  }

  async executeCommand(command: string, args: any[]): Promise<any> {
    await this.initialize();
    return this.send("workspace/executeCommand", {
      command,
      arguments: args,
    });
  }

  async shutdown(): Promise<void> {
    await this.send("shutdown", null);
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      method: "exit",
      params: null,
    });
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    this.process.stdin!.write(frame);
  }
}

// Mnemonic shortcuts to full command names (from clojure-lsp docs)
const COMMAND_SHORTCUTS: Record<string, string> = {
  ab: "drag-param-backward",
  af: "drag-param-forward",
  ai: "add-missing-import",
  am: "add-missing-libspec",
  as: "add-require-suggestion",
  cc: "cycle-coll",
  ck: "cycle-keyword-auto-resolve",
  cn: "clean-ns",
  cp: "cycle-privacy",
  ct: "create-test",
  df: "demote-fn",
  db: "drag-backward",
  dk: "destructure-keys",
  ed: "extract-to-def",
  ef: "extract-function",
  el: "expand-let",
  fe: "create-function",
  ga: "get-in-all",
  gl: "get-in-less",
  gm: "get-in-more",
  gn: "get-in-none",
  il: "introduce-let",
  is: "inline-symbol",
  ma: "resolve-macro-as",
  mf: "move-form",
  ml: "move-to-let",
  pf: "promote-fn",
  rr: "replace-refer-all-with-refer",
  ra: "replace-refer-all-with-alias",
  rk: "restructure-keys",
  sc: "change-coll",
  sl: "sort-clauses",
  tf: "thread-first-all",
  th: "thread-first",
  tl: "thread-last-all",
  tt: "thread-last",
  ua: "unwind-all",
  uw: "unwind-thread",
  fs: "forward-slurp",
  fb: "forward-barf",
  bs: "backward-slurp",
  bb: "backward-barf",
  rs: "raise-sexp",
  ks: "kill-sexp",
  ff: "forward",
  fr: "forward-select",
  gt: "go-to-test",
};

// Resolve shortcut to full command name
function resolveCommand(cmd: string): string {
  return COMMAND_SHORTCUTS[cmd] || cmd;
}

// Helper to build file URI
function fileUri(relativePath: string): string {
  const fullPath = relativePath.startsWith("/")
    ? relativePath
    : `${ROOT_PATH}/${relativePath}`;
  return pathToFileURL(fullPath).href;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

// Apply LSP TextEdit to file content
interface TextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

function applyEdits(content: string, edits: TextEdit[]): string {
  const lines = content.split("\n");

  // Sort edits in reverse order so we can apply them without offset issues
  const sortedEdits = [...edits].sort((a, b) => {
    if (b.range.start.line !== a.range.start.line) {
      return b.range.start.line - a.range.start.line;
    }
    return b.range.start.character - a.range.start.character;
  });

  for (const edit of sortedEdits) {
    const { start, end } = edit.range;

    // Get the text before the edit range
    const beforeLines = lines.slice(0, start.line);
    const startLineText = lines[start.line] || "";
    const before = beforeLines.join("\n") +
      (beforeLines.length > 0 ? "\n" : "") +
      startLineText.slice(0, start.character);

    // Get the text after the edit range
    const endLineText = lines[end.line] || "";
    const afterLines = lines.slice(end.line + 1);
    const after = endLineText.slice(end.character) +
      (afterLines.length > 0 ? "\n" : "") +
      afterLines.join("\n");

    // Reconstruct with new text
    const newContent = before + edit.newText + after;
    lines.length = 0;
    lines.push(...newContent.split("\n"));
  }

  return lines.join("\n");
}

// Apply workspace edit to files on disk
function applyWorkspaceEdit(result: any): { filesChanged: string[] } {
  const filesChanged: string[] = [];

  if (!result?.changes) {
    return { filesChanged };
  }

  for (const [fileUriStr, edits] of Object.entries(result.changes)) {
    const filePath = fileURLToPath(fileUriStr);
    const content = readFileSync(filePath, "utf-8");
    const newContent = applyEdits(content, edits as TextEdit[]);
    writeFileSync(filePath, newContent);
    filesChanged.push(filePath);
  }

  return { filesChanged };
}

const lsp = new LSPClient(ROOT_PATH);

createServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("Content-Type", "application/json");

  try {
    if (req.method === "POST" && req.url === "/command") {
      const body = JSON.parse(await readBody(req));
      const { command, file, row, col, ...rest } = body;

      // Build args array: [file-uri, row, col, ...extras]
      const args = [fileUri(file), row, col];

      // Add any extra args (name, filename, etc.)
      if (rest.name) args.push(rest.name);
      if (rest.filename) args.push(rest.filename);

      const result = await lsp.executeCommand(resolveCommand(command), args);
      const { filesChanged } = applyWorkspaceEdit(result);
      res.end(JSON.stringify({ ok: true, filesChanged }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  } catch (err: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message || err }));
  }
}).listen(PORT, async () => {
  console.log(`listening on http://localhost:${PORT}`);
  console.log("[lsp] pre-initializing...");
  await lsp.initialize();
  console.log("[lsp] ready");
});

process.on("SIGINT", async () => {
  await lsp.shutdown();
  process.exit(0);
});
