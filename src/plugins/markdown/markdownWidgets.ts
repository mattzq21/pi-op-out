import { EditorView, WidgetType } from "@codemirror/view";

export class BulletWidget extends WidgetType {
  eq() { return true; }

  toDOM() {
    const bullet = document.createElement("span");
    bullet.className = "notes-list-bullet";
    bullet.textContent = "•";
    bullet.setAttribute("aria-hidden", "true");

    return bullet;
  }
}

export class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly from: number, readonly to: number, readonly disabled: boolean) { super(); }

  eq(other: TaskWidget) { return this.checked === other.checked && this.from === other.from && this.to === other.to && this.disabled === other.disabled; }

  toDOM(view: EditorView) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "notes-task-checkbox";
    input.checked = this.checked;
    input.disabled = this.disabled;
    input.setAttribute("aria-label", this.checked ? "Mark task incomplete" : "Mark task complete");
    input.addEventListener("change", () => {
      if (view.state.readOnly) return;
      view.dispatch({ changes: { from: this.from, to: this.to, insert: input.checked ? "[x]" : "[ ]" }, userEvent: "input" });
    });

    return input;
  }
}
