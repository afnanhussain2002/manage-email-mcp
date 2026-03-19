import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import chalk from "chalk";
import { hello, echo } from "./tools.js";
import { getAuthUrl, oauth2Client } from "./gmailAuth.js";
import { deleteEmail, getRecentEmails, replyToEmail, sendEmail } from "./gmailService.js";
import dotenv from "dotenv";

dotenv.config();

// ============================================================================
// Dev Logging Utilities
// ============================================================================

const isDev = process.env.NODE_ENV !== "production";

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function formatLatency(ms: number): string {
  if (ms < 100) return chalk.green(`${ms}ms`);
  if (ms < 500) return chalk.yellow(`${ms}ms`);
  return chalk.red(`${ms}ms`);
}

function truncate(str: string, maxLen = 60): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function logRequest(method: string, params?: unknown): void {
  if (!isDev) return;

  const paramsStr = params ? chalk.gray(` ${truncate(JSON.stringify(params))}`) : "";
  console.log(`${chalk.gray(`[${timestamp()}]`)} ${chalk.cyan("→")} ${method}${paramsStr}`);
}

function logResponse(method: string, result: unknown, latencyMs: number): void {
  if (!isDev) return;

  const latency = formatLatency(latencyMs);

  // For tool calls, show the result
  if (method === "tools/call" && result) {
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    console.log(
      `${chalk.gray(`[${timestamp()}]`)} ${chalk.green("←")} ${truncate(resultStr)} ${chalk.gray(`(${latency})`)}`
    );
  } else {
    console.log(`${chalk.gray(`[${timestamp()}]`)} ${chalk.green("✓")} ${method} ${chalk.gray(`(${latency})`)}`);
  }
}

function logError(method: string, error: unknown, latencyMs: number): void {
  const latency = formatLatency(latencyMs);

  let errorMsg: string;
  if (error instanceof Error) {
    errorMsg = error.message;
  } else if (typeof error === "object" && error !== null) {
    // JSON-RPC error object has { code, message, data? }
    const rpcError = error as { message?: string; code?: number };
    errorMsg = rpcError.message || `Error ${rpcError.code || "unknown"}`;
  } else {
    errorMsg = String(error);
  }

  console.log(
    `${chalk.gray(`[${timestamp()}]`)} ${chalk.red("✖")} ${method} ${chalk.red(truncate(errorMsg))} ${chalk.gray(`(${latency})`)}`
  );
}

// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new McpServer({
  name: "gmail-assistant-mcp",
  version: "1.0.0",
});

// Register a simple "hello" tool
server.registerTool(
  "generate_greeting",
  {
    title: "Generate Greeting Message",
    description: "Create a friendly personalized greeting message for users or emails.",
    inputSchema: {
      name: z.string().describe("Name of the person"),
    },
    outputSchema: {
      message: z.string(),
    },
  },
  async ({ name }) => {
    const output = hello(name);
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  }
);

// Register an "echo" tool for testing
server.registerTool(
  "debug_echo",
  {
    title: "Debug Echo Tool",
    description: "Returns the exact input with timestamp. Useful for testing MCP connections and debugging.",
    inputSchema: {
      text: z.string().describe("Text to echo"),
    },
    outputSchema: {
      echo: z.string(),
      timestamp: z.string(),
    },
  },
  async ({ text }) => {
    const output = echo(text);
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  }
);

// ---------- Get Recent Emails ----------
server.registerTool(
  "get_recent_emails",
  {
    title: "Get Recent Emails",
    description: "Fetch the latest emails from Gmail",
    inputSchema: {},
    outputSchema: {
      emails: z.array(z.any()),
    },
  },
  async () => {
    const emails = await getRecentEmails();
    return {
      content: [{ type: "text", text: JSON.stringify(emails) }],
      structuredContent: { emails },
    };
  }
);

// ---------- Send Email ----------
server.registerTool(
  "send_email",
  {
    title: "Send Email",
    description: "Send an email to a recipient",
    inputSchema: {
      to: z.string(),
      subject: z.string(),
      body: z.string(),
    },
    outputSchema: { status: z.string() },
  },
  async ({ to, subject, body }) => {
    await sendEmail(to, subject, body);
    return {
      content: [{ type: "text", text: "Email sent successfully!" }],
      structuredContent: { status: "sent" },
    };
  }
);

// ---------- Reply to Email ----------
server.registerTool(
  "reply_email",
  {
    title: "Reply to Email",
    description: "Reply to a specific email by message ID",
    inputSchema: {
      messageId: z.string(),
      body: z.string(),
    },
    outputSchema: { status: z.string() },
  },
  async ({ messageId, body }) => {
    await replyToEmail(messageId, body);
    return {
      content: [{ type: "text", text: "Email replied successfully!" }],
      structuredContent: { status: "replied" },
    };
  }
);

// ---------- Delete Email ----------
server.registerTool(
  "delete_email",
  {
    title: "Delete Email",
    description: "Delete an email by message ID",
    inputSchema: { messageId: z.string() },
    outputSchema: { status: z.string() },
  },
  async ({ messageId }) => {
    await deleteEmail(messageId);
    return {
      content: [{ type: "text", text: "Email deleted successfully!" }],
      structuredContent: { status: "deleted" },
    };
  }
);

// ============================================================================
// Express App Setup
// ============================================================================

const app = express();
app.use(express.json());

// Health check endpoint (required for Cloud Run)
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "healthy" });
});

// MCP endpoint with dev logging
app.post("/mcp", async (req: Request, res: Response) => {
  const startTime = Date.now();
  const body = req.body;

  // Extract method and params from JSON-RPC request
  const method = body?.method || "unknown";
  const params = body?.params;

  // Log incoming request
  if (method === "tools/call") {
    const toolName = params?.name || "unknown";
    const toolArgs = params?.arguments;
    logRequest(`tools/call ${chalk.bold(toolName)}`, toolArgs);
  } else if (method !== "notifications/initialized") {
    logRequest(method, params);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // Capture response body for logging
  let responseBody = "";
  const originalWrite = res.write.bind(res) as typeof res.write;
  const originalEnd = res.end.bind(res) as typeof res.end;

  res.write = function (chunk: unknown, encodingOrCallback?: BufferEncoding | ((error: Error | null | undefined) => void), callback?: (error: Error | null | undefined) => void) {
    if (chunk) {
      responseBody += typeof chunk === "string" ? chunk : Buffer.from(chunk as ArrayBuffer).toString();
    }
    return originalWrite(chunk as string, encodingOrCallback as BufferEncoding, callback);
  };

  res.end = function (chunk?: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) {
    if (chunk) {
      responseBody += typeof chunk === "string" ? chunk : Buffer.from(chunk as ArrayBuffer).toString();
    }

    // Log response
    if (method !== "notifications/initialized") {
      const latency = Date.now() - startTime;

      try {
        const rpcResponse = JSON.parse(responseBody) as { result?: unknown; error?: unknown };

        if (rpcResponse?.error) {
          logError(method, rpcResponse.error, latency);
        } else if (method === "tools/call") {
          const content = (rpcResponse?.result as { content?: Array<{ text?: string }> })?.content;
          const resultText = content?.[0]?.text;
          logResponse(method, resultText, latency);
        } else {
          logResponse(method, null, latency);
        }
      } catch {
        logResponse(method, null, latency);
      }
    }

    return originalEnd(chunk as string, encodingOrCallback as BufferEncoding, callback);
  };

  res.on("close", () => {
    transport.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// 1. Redirect user to Google login
app.get("/auth", (_req, res) => {
  const url = getAuthUrl();
  res.redirect(url);
});

// 2. Handle callback
app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code as string;

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  console.log("✅ Tokens:", tokens);

  res.send("Gmail connected successfully!");
});

// JSON error handler (Express defaults to HTML errors)
app.use((_err: unknown, _req: Request, res: Response, _next: Function) => {
  res.status(500).json({ error: "Internal server error" });
});

// ============================================================================
// Start Server
// ============================================================================

const port = parseInt(process.env.PORT || "8080");
const httpServer = app.listen(port, () => {
  console.log();
  console.log(chalk.bold("MCP Server running on"), chalk.cyan(`http://localhost:${port}`));
  console.log(`  ${chalk.gray("Health:")} http://localhost:${port}/health`);
  console.log(`  ${chalk.gray("MCP:")}    http://localhost:${port}/mcp`);

  if (isDev) {
    console.log();
    console.log(chalk.gray("─".repeat(50)));
    console.log();
  }
});

// Graceful shutdown for Cloud Run (SIGTERM before kill)
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  httpServer.close(() => {
    process.exit(0);
  });
});
