import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { collectCompletedResponse, responseToChat } from "../src/protocol/responses";
import { parseSse } from "../src/sse";

function responseStream(events: Array<{ type: string; payload: Record<string, unknown> }>): ReadableStream<Uint8Array> {
  const body = events
    .map(({ type, payload }) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
    .join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  });
}

describe("SSE parser", () => {
  it("handles split UTF-8, CRLF, comments, multiline data and multiple events", async () => {
    const source = "\ufeff: ping\r\nevent: first\r\ndata: 你\r\ndata: 好\r\n\r\nevent: second\ndata: {\"ok\":true}\n\n";
    const bytes = new TextEncoder().encode(source.slice(1));
    const chunks = [bytes.slice(0, 31), bytes.slice(31, 32), bytes.slice(32, 48), bytes.slice(48)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      }
    });
    const events = [];
    for await (const event of parseSse(stream)) events.push(event);
    expect(events).toEqual([
      { event: "first", data: "你\n好" },
      { event: "second", data: "{\"ok\":true}" }
    ]);
  });
});

describe("completed Responses aggregation", () => {
  it("rebuilds empty terminal output for ordinary Responses and Chat", async () => {
    const text = "这是一段九字正文。";
    const reasoning = { id: "rs_real", type: "reasoning", summary: [] };
    const message = {
      id: "msg_real",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }]
    };
    const completed = await collectCompletedResponse(responseStream([
      { type: "response.output_item.done", payload: { output_index: 0, item: reasoning } },
      { type: "response.output_item.done", payload: { output_index: 1, item: message } },
      {
        type: "response.completed",
        payload: {
          response: {
            id: "resp_real",
            object: "response",
            status: "completed",
            model: "gpt-5.5",
            output: [],
            output_text: ""
          }
        }
      }
    ]));

    expect(completed.output).toEqual([reasoning, message]);
    expect(completed.output_text).toBe(text);
    expect((responseToChat(completed, "gpt-5.5").choices as Array<{ message: { content: string } }>)[0]?.message.content).toBe(text);

    const client = new OpenAI({
      apiKey: "test-only",
      fetch: async () => Response.json(completed)
    });
    expect((await client.responses.create({ model: "gpt-5.5", input: "test" })).output_text).toBe(text);
  });

  it("keeps a populated terminal output without duplicating or replacing it", async () => {
    const streamedMessage = {
      id: "msg_streamed",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "streamed", annotations: [] }]
    };
    const terminalOutput = [{
      id: "msg_terminal",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "terminal", annotations: [] }]
    }];
    const completed = await collectCompletedResponse(responseStream([
      { type: "response.output_item.done", payload: { output_index: 0, item: streamedMessage } },
      {
        type: "response.completed",
        payload: { response: { id: "resp_complete", object: "response", status: "completed", output: terminalOutput } }
      }
    ]));

    expect(completed.output).toEqual(terminalOutput);
  });

  it("orders recovered reasoning, message and function calls by output_index", async () => {
    const reasoning = { id: "rs_order", type: "reasoning", summary: [] };
    const message = {
      id: "msg_order",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ordered text", annotations: [] }]
    };
    const tool = {
      id: "fc_order",
      type: "function_call",
      call_id: "call_order",
      name: "lookup",
      arguments: "{\"id\":1}",
      status: "completed"
    };
    const completed = await collectCompletedResponse(responseStream([
      { type: "response.output_item.done", payload: { output_index: 2, item: tool } },
      { type: "response.output_item.done", payload: { output_index: 0, item: reasoning } },
      { type: "response.output_item.done", payload: { output_index: 1, item: message } },
      {
        type: "response.completed",
        payload: { response: { id: "resp_order", object: "response", status: "completed", output_text: "terminal text" } }
      }
    ]));

    expect((completed.output as Array<{ type: string }>).map((item) => item.type)).toEqual(["reasoning", "message", "function_call"]);
    expect(completed.output_text).toBe("terminal text");
    expect(responseToChat(completed, "gpt-5.5").choices).toEqual([{
      index: 0,
      message: {
        role: "assistant",
        content: "ordered text",
        tool_calls: [{ id: "call_order", type: "function", function: { name: "lookup", arguments: "{\"id\":1}" } }]
      },
      finish_reason: "tool_calls"
    }]);
  });
});