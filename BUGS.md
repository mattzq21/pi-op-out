# Confirmed UI bugs

Manually reproduced on 2026-09-03 against the latest release WebDriver build with the WDIO MCP. Unless noted otherwise, the window was at the app's supported minimum size of 900 × 640. Product code was not changed during testing.

## 1. Extension dialogs can put all actions outside the viewport

- **Severity:** High
- **Reproduction:** Emit an extension editor request containing about 120 ordinary words, a select request containing 12 options, or a message containing several hundred words.
- **Observed:** The dialog grows beyond the 640 px viewport with no internal scrolling. For a 120-word editor request the dialog was 674 px high and the action row ended at y=652. A 12-option select was 676 px high and ended at y=654. A 600-word message produced a 2,118 px dialog whose Cancel/Continue actions were near y=2,063.
- **Expected:** The dialog should be capped to the viewport and scroll internally, while its actions remain reachable.

## 2. Attachments leak between conversations

- **Severity:** High
- **Reproduction:** Attach a file in one conversation, then select two other conversations from the sidebar without sending.
- **Observed:** The attachment chip remains present after both conversation changes, so a file chosen for one conversation can be sent to another accidentally.
- **Expected:** Composer attachments should be scoped to the conversation draft or cleared when the active conversation changes.

## 3. Seven or more terminal tabs displace the entire workspace

- **Severity:** High
- **Reproduction:** At 900 × 640, open the terminal and add terminals until seven or more tabs exist.
- **Observed:** With seven tabs, the 668 px chat pane moves from x=232 to x=167 and is clipped beneath the sidebar. With eight tabs it moves to x=78. At nine tabs the terminal header becomes 911 px wide and its Delete/Close controls move beyond the right edge (Close begins at x=929). Ten tabs produce a 1,000 px header and visibly hide later tabs and controls.
- **Expected:** The tab list should scroll within the available header width, while the chat pane and terminal controls remain fixed and visible.

## 4. Prompt-context controls are clipped in split panes

- **Severity:** Medium
- **Reproduction:** At 900 × 640, open a split pane for a conversation containing prompt-context details.
- **Observed:** Each chat pane is about 333.5 px wide. The prompt-context container has 260 px of client width but 403 px of content. System and Instructions remain visible, Tools is partial, and Skills plus the context wheel are completely clipped. The component uses hidden overflow, so the missing controls cannot be reached.
- **Expected:** All prompt-context controls should wrap, condense, or remain horizontally accessible.

## 5. Composer controls overlap in split panes

- **Severity:** Medium
- **Reproduction:** At 900 × 640, open a split pane and inspect both composers.
- **Observed:** The composer tool group shrinks to about 18.8 px while its children escape the flex item. In the main pane the context wheel completely overlaps the Agent trigger; in the split pane it overlaps the Agent trigger by about 11 px. Other tool controls are crowded into the selector area as well.
- **Expected:** Composer controls should reflow or hide behind an overflow menu without overlapping.

## 6. Settings require horizontal scrolling near the minimum width

- **Severity:** Medium
- **Reproduction:** Open Settings with the window between 900 and 950 px wide.
- **Observed:** At 900 px the settings content has a 660 px client width but a 730 px scroll width. The context-window cap control is clipped, the default-model field runs off-screen, and a horizontal scrollbar is required. Overflow remains at 950 px and disappears around 1,000 px.
- **Expected:** Settings should adapt to the documented minimum window width without clipping fields or requiring page-level horizontal scrolling.

## 7. Long unbroken extension text is clipped across toast, widget, and status surfaces

- **Severity:** Medium
- **Reproduction:** Emit toast, widget, or status content containing a long path, URL-like value, identifier, or other unbroken string.
- **Observed:** A realistic 96-character path makes the 390 px toast scroll to 574 px. Longer values extend thousands of pixels. A 200-character token gives the widget a 2,140 px scroll width and the status a 1,284 px scroll width. Content is clipped by ancestors instead of wrapping.
- **Expected:** Extension-provided text should wrap safely within each surface.

## 8. Text attachment filenames can corrupt the prompt wrapper

- **Severity:** Medium
- **Reproduction:** Attach a text file whose valid filename contains `&` or `<`, then submit through the mocked prompt bridge and inspect the generated prompt.
- **Observed:** A file named `research & notes.txt` generates `<file name="research & notes.txt">`, and `<important>&notes.txt` is inserted verbatim. Only double quotes are escaped, leaving invalid or structurally ambiguous XML-like markup.
- **Expected:** Attribute-sensitive characters should be escaped consistently, or filenames should be transported as structured data rather than interpolated markup.

## 9. Duplicate attachment chips cannot be removed individually

- **Severity:** Low
- **Reproduction:** Attach the same file twice, then remove either one of the two chips.
- **Observed:** Two identical chips are shown, but clicking either Remove button deletes both. This reproduces regardless of which duplicate is removed because both files receive the same name-and-last-modified identifier.
- **Expected:** Either prevent duplicate attachments or give each chip a unique identity so one removal affects one item.

## 10. Long unbroken message content is clipped and unreadable

- **Severity:** Medium
- **Reproduction:** Display a user or assistant message containing a long unbroken path, URL, hash, identifier, or token.
- **Observed:** With a 240-character token, the user message body has 487 px of client width but 2,407 px of scroll width, and the assistant body has 596 px of client width but 2,390 px of scroll width. The enclosing message viewport hides horizontal overflow, so the content runs beyond the right edge and cannot be scrolled into view.
- **Expected:** Ordinary message text should wrap within the conversation or provide a local horizontal scrolling affordance for content that must remain unbroken.

## 11. Keyboard focus lands on invisible Archive controls

- **Severity:** Medium
- **Reproduction:** Move the pointer away from the sidebar, focus a conversation button with the keyboard, then press Tab once.
- **Observed:** Focus moves to that row's `Archive conversation` button, but the control remains at opacity 0 with pointer events disabled and no visible focus outline. Pressing Tab through the conversation list therefore visits an invisible destructive action after every session.
- **Expected:** A keyboard-focused archive action should become visibly focused, or hover-only row actions should be removed from the tab sequence and exposed through an accessible menu.

## 12. App modals do not trap keyboard focus or support Escape

- **Severity:** Medium
- **Reproduction:** Open either an extension dialog or the Open project dialog, then use Tab, Shift+Tab, or Escape. For the initial-focus case, focus a background control before opening a confirm/select extension dialog.
- **Observed:** Confirm/select extension dialogs leave focus on the background conversation control. In both extension and project dialogs, tabbing past the final dialog button moves focus outside the modal (to the E2E bridge in the test build), despite `aria-modal="true"`. Pressing Escape does nothing in either dialog.
- **Expected:** Opening a modal should move focus inside it, keep focus trapped there, close on Escape when cancellation is available, and restore focus appropriately after closing.

## 13. Composer listboxes do not support listbox keyboard navigation

- **Severity:** Low
- **Reproduction:** Focus the Agent, Model, or Thinking trigger, press Enter to open it, then press Arrow Down or Arrow Up.
- **Observed:** The menu opens with focus left on the trigger. Arrow keys do not move active focus or the selected option; the only implemented listbox key is Escape. Options can only be reached by tabbing through every button or using a pointer.
- **Expected:** A control exposed as an ARIA listbox should move focus/active-descendant with Arrow keys and allow the focused option to be selected from the keyboard.

## 14. Wide Markdown tables are clipped with no horizontal scroller

- **Severity:** Medium
- **Reproduction:** Display a Markdown table with enough ordinary short columns to exceed the message width (20 columns reproduces reliably at 900 × 640).
- **Observed:** The rendered table is about 1,200 px wide inside a 596 px message body. The conversation viewport hides horizontal overflow, so columns past the right edge are inaccessible even though the cell content itself contains normal wrapping opportunities.
- **Expected:** Wide tables should be contained by a horizontally scrollable wrapper or transformed into a responsive representation.

## 15. Concurrent extension dialogs silently discard earlier requests

- **Severity:** High
- **Reproduction:** Emit interactive extension request A, then emit interactive request B before answering A. Cancel or answer B.
- **Observed:** B immediately replaces A because the app stores only one dialog request. After B is dismissed, no dialog returns for A. The recorded backend calls contain a response for B only; A is neither answered nor cancelled, leaving its caller able to wait forever.
- **Expected:** Interactive requests should be queued, or a superseded request should receive an explicit cancellation response before it is removed.

## 16. Split-pane conversations ignore interactive extension requests

- **Severity:** High
- **Reproduction:** Open a real conversation in a split pane, then send an `input`, `editor`, `select`, or `confirm` extension UI request to that split runtime.
- **Observed:** The split runtime receives extension UI events but handles only two special `setStatus` keys. The interactive request produces no dialog and no `extension_ui_response`; the requesting extension can wait indefinitely.
- **Expected:** Split conversations should support the same interactive extension UI contract as the main conversation, or explicitly cancel unsupported requests so callers cannot hang.

## 17. Multi-line extension widgets grow above the viewport

- **Severity:** Medium
- **Reproduction:** Emit a widget containing about 50 ordinary short lines at 900 × 640.
- **Observed:** The widget becomes 818 px tall inside the bottom-pinned composer stack, placing its top at y=-281. The first 17 lines are above the viewport and there is no widget or stack scroller with which to reach them.
- **Expected:** Widget height should be capped to the available space with internal scrolling, truncation, or an explicit expand/collapse affordance.
