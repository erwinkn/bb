#!/usr/bin/env node
import readline from "node:readline";

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const mcp = (requestId, id, method, params) =>
  write({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "mcp_message",
      server_name: "bb-bridge",
      message: { jsonrpc: "2.0", id, method, params },
    },
  });

let initialize;
let list;
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    if (message.request.subtype === "initialize") {
      initialize = message;
      mcp("probe-list", 1, "tools/list", {});
      return;
    }
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {},
      },
    });
    return;
  }
  if (message.type !== "control_response") return;
  if (message.response.request_id === "probe-list") {
    list = message.response;
    mcp("probe-call", 2, "tools/call", {
      name: "initiative_read",
      arguments: {},
    });
    return;
  }
  if (message.response.request_id === "probe-call") {
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: initialize.request_id,
        response: {
          account: {},
          models: [],
          commands: [],
          mcpProbe: { list, call: message.response },
        },
      },
    });
  }
});
input.on("close", () => process.exit(0));
