import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("Pi desktop", () => {
  it("loads the web transport, grouped sessions, and response branch controls", async () => {
    render(<App />);
    expect((await screen.findAllByText("Design desktop shell")).length).toBeGreaterThan(0);
    expect(screen.getByText("northstar")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Branch from here" })).toHaveLength(2);
    expect(screen.getByTitle("browser transport connected")).toBeInTheDocument();
  });

  it("switches conversations from the right panel", async () => {
    const user = userEvent.setup(); render(<App />);
    expect((await screen.findByRole("textbox", { name: "Search conversations" })).closest(".icon-rail")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /Wire RPC transport/ }));
    expect((await screen.findAllByText("Wire RPC transport")).length).toBeGreaterThan(0);
    expect(await screen.findByText(/browser preview for/)).toHaveTextContent("Wire RPC transport");
  });

  it("sends a prompt and renders the streamed browser response", async () => {
    const user = userEvent.setup(); render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    await user.type(composer, "Check the session protocol{enter}");
    expect(await screen.findByText(/no model was charged/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/no model was charged/).closest("article")).toHaveTextContent("local pi process"));
  });

  it("configures MCP servers from settings", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /MCP servers/ }));
    expect(screen.getByDisplayValue("Filesystem")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add MCP server" }));
    expect(screen.getByDisplayValue("New server")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("button", { name: "Saved" })).toBeInTheDocument();
  });

  it("opens session stats and the persisted branch tree", async () => {
    const user = userEvent.setup(); render(<App />); await screen.findByRole("textbox", { name: "Search conversations" });
    await user.click(screen.getByRole("button", { name: "Conversation menu" }));
    await user.click(screen.getByRole("button", { name: "Tree & session stats" }));
    expect(await screen.findByRole("heading", { name: "Context & branches" })).toBeInTheDocument();
    expect(screen.getByText(/billed tokens/)).toBeInTheDocument();
    expect(screen.getByText("Conversation tree")).toBeInTheDocument();
  });

  it("runs project shell commands in the terminal view", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    const input = await screen.findByRole("textbox", { name: "Terminal command" });
    await user.type(input, "git status{enter}");
    expect(await screen.findByText(/command execution is available/)).toBeInTheDocument();
    expect(await screen.findByText("exit 0")).toBeInTheDocument();
  });

  it("keeps model and effort controls in the composer bar", async () => {
    render(<App />);
    const model = await screen.findByRole("combobox", { name: "Model" });
    const effort = screen.getByRole("combobox", { name: "Thinking level" });
    expect(model.closest(".composer-bar")).toBeInTheDocument();
    expect(effort.closest(".composer-bar")).toBeInTheDocument();
    expect(document.querySelector(".chat-header select")).not.toBeInTheDocument();
  });

  it("captures editable keybinds in settings", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: /Keybinds/ }));
    const terminalShortcut = screen.getByRole("textbox", { name: "Toggle terminal shortcut" });
    expect(terminalShortcut).toHaveValue("Mod+J");
    fireEvent.keyDown(terminalShortcut, { key: "t", ctrlKey: true, shiftKey: true });
    expect(terminalShortcut).toHaveValue("Mod+Shift+T");
  });

  it("toggles the terminal with the default keybind", async () => {
    render(<App />);
    await screen.findByRole("textbox", { name: "Message Pi" });
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    expect(await screen.findByRole("textbox", { name: "Terminal command" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    expect(await screen.findByRole("textbox", { name: "Message Pi" })).toBeInTheDocument();
  });

  it("discovers slash commands and attaches text context", async () => {
    const user = userEvent.setup(); render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    await user.type(composer, "/");
    expect(await screen.findByRole("option", { name: /review/i })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /review/i }));
    expect(composer).toHaveValue("/review ");
    const picker = document.querySelector('input[type="file"]:not([accept])') as HTMLInputElement;
    await user.upload(picker, new File(["important context"], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
  });
});
