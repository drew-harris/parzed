// server.ts
import { spawn, ChildProcess } from "child_process";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { pathToFileURL, fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync } from "fs";
import * as nreplClient from "nrepl-client";

const ROOT_PATH = "/Users/drew/programs/instant/server";
const PORT = 7834;

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

  private notify(method: string, params: any): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    this.process.stdin!.write(frame);
  }

  private fileVersions = new Map<string, number>();

  syncFile(fileUri: string, content: string): void {
    const version = (this.fileVersions.get(fileUri) || 0) + 1;
    this.fileVersions.set(fileUri, version);

    // Send didOpen if first time, otherwise didChange
    if (version === 1) {
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri: fileUri,
          languageId: "clojure",
          version,
          text: content,
        },
      });
    } else {
      this.notify("textDocument/didChange", {
        textDocument: { uri: fileUri, version },
        contentChanges: [{ text: content }],
      });
    }
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

// nREPL Client for REPL evaluation
interface EvalHistoryEntry {
  id: string;
  timestamp: number;
  ns: string;
  code: string;
  value?: string;
  out?: string;
  err?: string;
  error?: string;
  ms: number;
  file?: string;
}

const evalHistory: EvalHistoryEntry[] = [];
const MAX_HISTORY = 500;

class NREPLClient {
  private connection: ReturnType<typeof nreplClient.connect> | null = null;
  private connecting = false;

  private getPort(): number {
    const portFile = `${ROOT_PATH}/.nrepl-port`;
    if (!existsSync(portFile)) {
      throw new Error(`nREPL port file not found: ${portFile}`);
    }
    return parseInt(readFileSync(portFile, "utf-8").trim(), 10);
  }

  async connect(): Promise<void> {
    if (this.connection && !this.connection.destroyed) {
      return;
    }
    if (this.connecting) {
      // Wait for existing connection attempt
      while (this.connecting) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return;
    }

    this.connecting = true;
    const port = this.getPort();

    return new Promise((resolve, reject) => {
      console.log(`[nrepl] connecting to port ${port}...`);
      this.connection = nreplClient.connect({ port });

      this.connection.once("connect", () => {
        console.log("[nrepl] connected");
        this.connecting = false;
        resolve();
      });

      this.connection.once("error", (err: Error) => {
        console.error("[nrepl] connection error:", err.message);
        this.connection = null;
        this.connecting = false;
        reject(err);
      });

      this.connection.on("close", () => {
        console.log("[nrepl] connection closed");
        this.connection = null;
      });
    });
  }

  async eval(code: string, ns: string): Promise<EvalHistoryEntry> {
    await this.connect();

    const id = crypto.randomUUID();
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      // Wrap code in ns switch if needed
      const wrappedCode = ns !== "user" ? `(in-ns '${ns}) ${code}` : code;

      this.connection!.eval(wrappedCode, (err, results) => {
        const ms = Date.now() - startTime;

        if (err) {
          const entry: EvalHistoryEntry = {
            id,
            timestamp: startTime,
            ns,
            code,
            error: err.message,
            ms,
          };
          evalHistory.push(entry);
          if (evalHistory.length > MAX_HISTORY) evalHistory.shift();
          reject(err);
          return;
        }

        // Combine all result messages
        let value: string | undefined;
        let out = "";
        let errOut = "";

        for (const r of results) {
          if (r.value !== undefined) value = r.value;
          if (r.out) out += r.out;
          if (r.err) errOut += r.err;
          if (r.ex) errOut += r.ex;
        }

        const entry: EvalHistoryEntry = {
          id,
          timestamp: startTime,
          ns,
          code,
          value,
          out: out || undefined,
          err: errOut || undefined,
          ms,
        };

        evalHistory.push(entry);
        if (evalHistory.length > MAX_HISTORY) evalHistory.shift();

        resolve(entry);
      });
    });
  }

  close(): void {
    if (this.connection) {
      this.connection.end();
      this.connection = null;
    }
  }
}

// Find the form at cursor position using paren balancing
// Returns { start, end, code } or null if not inside a form
function findFormAtCursor(
  content: string,
  row: number,
  col: number,
): { start: number; end: number; code: string } | null {
  const lines = content.split("\n");

  // Convert row/col to absolute offset
  let offset = 0;
  for (let i = 0; i < row && i < lines.length; i++) {
    offset += (lines[i]?.length ?? 0) + 1; // +1 for newline
  }
  offset += Math.min(col, lines[row]?.length ?? 0);

  const opens = "([{";
  const closes = ")]}";
  const matchingClose: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
  };

  // State for parsing
  let inString = false;
  let inComment = false;
  let escape = false;

  // Helper to check state at a position
  function parseStateTo(pos: number): {
    inString: boolean;
    inComment: boolean;
  } {
    let str = false;
    let comment = false;
    let esc = false;

    for (let i = 0; i < pos && i < content.length; i++) {
      const ch = content[i];

      if (comment) {
        if (ch === "\n") comment = false;
        continue;
      }

      if (str) {
        if (esc) {
          esc = false;
        } else if (ch === "\\") {
          esc = true;
        } else if (ch === '"') {
          str = false;
        }
        continue;
      }

      if (ch === ";") {
        comment = true;
      } else if (ch === '"') {
        str = true;
      }
    }

    return { inString: str, inComment: comment };
  }

  // Walk backward to find the start of enclosing form
  let formStart = -1;
  let depth = 0;
  let searchPos = offset;

  // First, check if we're inside a string or comment
  const stateAtCursor = parseStateTo(offset);
  if (stateAtCursor.inString || stateAtCursor.inComment) {
    // Walk back to find start of string/comment, then continue
    // For now, just fail - user should move cursor
    return null;
  }

  // Walk backward
  for (let i = offset - 1; i >= 0; i--) {
    const state = parseStateTo(i);
    if (state.inString || state.inComment) continue;

    const ch = content[i]!;

    if (closes.includes(ch)) {
      depth++;
    } else if (opens.includes(ch)) {
      if (depth === 0) {
        formStart = i;
        break;
      }
      depth--;
    }
  }

  if (formStart === -1) {
    return null;
  }

  // Walk forward from formStart to find matching close
  const openChar = content[formStart]!;
  const closeChar = matchingClose[openChar]!;
  depth = 0;
  inString = false;
  inComment = false;
  escape = false;

  for (let i = formStart; i < content.length; i++) {
    const ch = content[i];

    if (inComment) {
      if (ch === "\n") inComment = false;
      continue;
    }

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === ";") {
      inComment = true;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return {
          start: formStart,
          end: i + 1,
          code: content.slice(formStart, i + 1),
        };
      }
    }
  }

  return null;
}

// Extract namespace from Clojure file content
function extractNamespace(content: string): string {
  // Match (ns some.namespace ...) or (ns some.namespace)
  // Handles: (ns foo.bar), (ns ^:meta foo.bar), (ns ^{:doc "..."} foo.bar)
  const nsMatch = content.match(
    /\(\s*ns\s+(?:\^[^\s]+\s+|\^{[^}]*}\s+)?([a-zA-Z][a-zA-Z0-9.*_-]*)/,
  );
  if (nsMatch && nsMatch[1]) {
    return nsMatch[1];
  }
  return "user";
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
    const before =
      beforeLines.join("\n") +
      (beforeLines.length > 0 ? "\n" : "") +
      startLineText.slice(0, start.character);

    // Get the text after the edit range
    const endLineText = lines[end.line] || "";
    const afterLines = lines.slice(end.line + 1);
    const after =
      endLineText.slice(end.character) +
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
function applyWorkspaceEdit(
  result: any,
  lspClient: LSPClient,
): { filesChanged: string[] } {
  const filesChanged: string[] = [];

  if (!result?.changes) {
    return { filesChanged };
  }

  for (const [fileUriStr, edits] of Object.entries(result.changes)) {
    const filePath = fileURLToPath(fileUriStr);
    const contentBefore = readFileSync(filePath, "utf-8");
    const newContent = applyEdits(contentBefore, edits as TextEdit[]);

    // Check if LSP already modified the file
    const contentNow = readFileSync(filePath, "utf-8");
    if (contentNow !== contentBefore) {
      console.log(`[applyEdit] FILE ALREADY CHANGED by LSP: ${filePath}`);
      console.log(
        `[applyEdit] Before length: ${contentBefore.length}, Now length: ${contentNow.length}`,
      );
    } else {
      console.log(
        `[applyEdit] File unchanged, applying edit ourselves: ${filePath}`,
      );
    }

    writeFileSync(filePath, newContent);
    filesChanged.push(filePath);

    // Sync the updated content back to LSP
    lspClient.syncFile(fileUriStr, newContent);
  }

  return { filesChanged };
}

const lsp = new LSPClient(ROOT_PATH);
const nrepl = new NREPLClient();

createServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("Content-Type", "application/json");

  try {
    if (req.method === "POST" && req.url === "/command") {
      const body = JSON.parse(await readBody(req));
      const { command, file, row, col, ...rest } = body;

      console.log(
        `[request] command=${command} file=${file} row=${row} col=${col}`,
      );

      // Build args array: [file-uri, row, col, ...extras]
      const uri = fileUri(file);
      const args = [uri, row, col];

      // Add any extra args (name, filename, etc.)
      if (rest.name) args.push(rest.name);
      if (rest.filename) args.push(rest.filename);

      // Sync file content with LSP before executing command
      const filePath = file.startsWith("/") ? file : `${ROOT_PATH}/${file}`;
      const content = readFileSync(filePath, "utf-8");
      lsp.syncFile(uri, content);

      const fullCommand = resolveCommand(command);
      console.log(`[request] resolved command: ${fullCommand}, args:`, args);

      const result = await lsp.executeCommand(fullCommand, args);
      console.log(`[result]`, JSON.stringify(result, null, 2));

      const { filesChanged } = applyWorkspaceEdit(result, lsp);
      res.end(JSON.stringify({ ok: true, filesChanged }));
    } else if (req.method === "POST" && req.url === "/eval") {
      const body = JSON.parse(await readBody(req));
      const { code, ns, file, row, col } = body;

      let evalCode = code;
      let content: string | undefined;

      // If no code provided but we have file + cursor position, find form at cursor
      if (!evalCode && file && row !== undefined && col !== undefined) {
        try {
          content = readFileSync(file, "utf-8");
          const form = findFormAtCursor(content, row, col);
          if (form) {
            evalCode = form.code;
          } else {
            res.statusCode = 400;
            res.end(
              JSON.stringify({ error: "No form found at cursor position" }),
            );
            return;
          }
        } catch (err: any) {
          res.statusCode = 400;
          res.end(
            JSON.stringify({ error: `Could not read file: ${err.message}` }),
          );
          return;
        }
      }

      if (!evalCode) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            error: "No code provided and no cursor position to find form",
          }),
        );
        return;
      }

      // Determine namespace: explicit ns > extract from file > default to "user"
      let namespace = ns;
      if (!namespace && file) {
        try {
          content = content || readFileSync(file, "utf-8");
          namespace = extractNamespace(content);
        } catch {
          namespace = "user";
        }
      }
      namespace = namespace || "user";

      console.log(`[eval] ns=${namespace} code=${evalCode.slice(0, 50)}...`);

      const result = await nrepl.eval(evalCode, namespace);
      result.file = file;
      res.end(JSON.stringify(result));
    } else if (req.method === "GET" && req.url?.startsWith("/history")) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const last = url.searchParams.get("last");

      let results = evalHistory;
      if (last) {
        const n = parseInt(last, 10);
        results = evalHistory.slice(-n);
      }

      res.end(JSON.stringify(results));
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

async function shutdown() {
  console.log("\n[server] shutting down...");
  nrepl.close();
  try {
    await Promise.race([
      lsp.shutdown(),
      new Promise((_, reject) => setTimeout(() => reject("timeout"), 2000)),
    ]);
  } catch (e) {
    console.log("[server] shutdown timeout, forcing exit");
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
