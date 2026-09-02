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
