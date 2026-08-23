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

  it("collapses and expands sessions by project", async () => {
    const user = userEvent.setup(); render(<App />);
    const project = await screen.findByRole("button", { name: "pi-ai" });
    expect(screen.getByRole("button", { name: /Wire RPC transport/ })).toBeVisible();
    await user.click(project);
    expect(project).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /Wire RPC transport/ })).not.toBeInTheDocument();
    await user.click(project);
    expect(project).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Wire RPC transport/ })).toBeVisible();
  });

  it("keeps composer drafts with their sessions", async () => {
    const user = userEvent.setup(); render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    await user.type(composer, "draft for desktop shell");
    await user.click(screen.getByRole("button", { name: /Wire RPC transport/ }));
    await waitFor(() => expect(composer).toHaveValue(""));
    await user.type(composer, "draft for rpc");
    await user.click(screen.getByRole("button", { name: /Design desktop shell/ }));
    await waitFor(() => expect(composer).toHaveValue("draft for desktop shell"));
    await user.click(screen.getByRole("button", { name: /Wire RPC transport/ }));
    await waitFor(() => expect(composer).toHaveValue("draft for rpc"));
  });

  it("asks for a replacement project directory before opening an unavailable session", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole("button", { name: /Fix token refresh/ }));
    expect(await screen.findByRole("heading", { name: "Locate conversation project" })).toBeInTheDocument();
    const path = screen.getByRole("textbox", { name: "Replacement project directory" });
    await user.clear(path); await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Locate conversation project" })).toBeInTheDocument();
    expect(screen.getByText("Path can't be empty")).toHaveClass("dialog-error");
    await user.type(path, "/home/demo/northstar");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/browser preview for/)).toHaveTextContent("Fix token refresh");
  });

  it("sends a prompt and renders the streamed browser response", async () => {
    const user = userEvent.setup(); render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    await user.type(composer, "Check the session protocol{enter}");
    expect(await screen.findByText(/no model was charged/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/no model was charged/).closest("article")).toHaveTextContent("local pi process"));
  });

  it("restores and replaces an aborted prompt from the composer", async () => {
    const user = userEvent.setup(); render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    await user.type(composer, "trigger aborted response{enter}");
    expect(await screen.findByText("Operation aborted")).toBeVisible();
    await waitFor(() => expect(composer).toHaveValue("trigger aborted response"));
    await user.clear(composer); await user.type(composer, "replacement prompt{enter}");
    expect(await screen.findByText(/no model was charged/)).toBeVisible();
    await waitFor(() => expect(document.querySelector(".messages")).not.toHaveTextContent("trigger aborted response"));
    expect(document.querySelector(".messages")).toHaveTextContent("replacement prompt");
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

  it("offers conversation actions without tree and session stats", async () => {
    render(<App />); await screen.findByRole("textbox", { name: "Search conversations" });
    expect(screen.queryByRole("button", { name: "Conversation menu" })).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByRole("button", { name: /Wire RPC transport/ }), { clientX: 100, clientY: 100 });
    expect(screen.getByRole("menuitem", { name: "Rename conversation" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Clone conversation" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Archive conversation" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Export as HTML" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Tree & session stats" })).not.toBeInTheDocument();
  });

  it("archives a conversation from its right-click menu", async () => {
    const user = userEvent.setup(); render(<App />); await screen.findByRole("textbox", { name: "Search conversations" });
    fireEvent.contextMenu(screen.getByRole("button", { name: /Wire RPC transport/ }), { clientX: 100, clientY: 100 });
    await user.click(screen.getByRole("menuitem", { name: "Archive conversation" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Wire RPC transport/ })).not.toBeInTheDocument());
  });

  it("runs project shell commands in a bottom panel", async () => {
    const user = userEvent.setup(); render(<App />);
    expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open terminal" }));
    const input = await screen.findByRole("textbox", { name: "Terminal input" });
    expect(screen.getByRole("textbox", { name: "Message Pi" })).toBeInTheDocument();
    expect(input.closest(".terminal-shell")?.previousElementSibling).toHaveClass("chat-shell");
    await user.type(input, "git status{enter}");
    await waitFor(() => expect(document.querySelector(".terminal-host")).toHaveTextContent("native builds run a real PTY shell"));
  });

  it("waits for a new conversation to establish its CWD before starting a terminal", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", { name: "New conversation" }));
    expect(await screen.findByText("π")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open terminal" }));
    expect(await screen.findByText("Start the conversation to get a CWD")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Terminal input" })).not.toBeInTheDocument();
  });

  it("keeps terminal output with the session that ran it", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", { name: "Open terminal" }));
    await user.type(await screen.findByRole("textbox", { name: "Terminal input" }), "git status{enter}");
    await waitFor(() => expect(document.querySelector(".terminal-host")).toHaveTextContent("native builds run a real PTY shell"));
    await user.click(screen.getByRole("button", { name: /Wire RPC transport/ }));
    expect(document.querySelector(".terminal-host")).not.toHaveTextContent("native builds run a real PTY shell");
    await user.click(screen.getByRole("button", { name: /Design desktop shell/ }));
    await waitFor(() => expect(document.querySelector(".terminal-host")).toHaveTextContent("native builds run a real PTY shell"));
  });

  it("adds and deletes independent terminal tabs within a session", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", { name: "Open terminal" }));
    await user.type(await screen.findByRole("textbox", { name: "Terminal input" }), "git status{enter}");
    await waitFor(() => expect(document.querySelector(".terminal-host")).toHaveTextContent("git status"));
    await user.click(screen.getByRole("button", { name: "Add terminal" }));
    expect(screen.getByRole("button", { name: /Terminal 2/ })).toHaveClass("active");
    expect(document.querySelector(".terminal-host")).not.toHaveTextContent("git status");
    await user.click(screen.getByRole("button", { name: "Delete terminal" }));
    expect(screen.queryByRole("button", { name: /Terminal 2/ })).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".terminal-host")).toHaveTextContent("git status"));
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
    expect(terminalShortcut).toHaveValue("Ctrl+J");
    fireEvent.keyDown(terminalShortcut, { key: "t", ctrlKey: true, shiftKey: true });
    expect(terminalShortcut).toHaveValue("Ctrl+Shift+T");
  });

  it("toggles the terminal with the default keybind", async () => {
    render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    expect(await screen.findByRole("textbox", { name: "Terminal input" })).toBeInTheDocument();
    expect(composer).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Terminal input" })).not.toBeInTheDocument());
    expect(composer).toBeInTheDocument();
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
