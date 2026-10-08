import { Key } from "@solid-primitives/keyed";
import { createSignal, Show } from "solid-js";
import { createDependencyEffect, createRef, type RefObject } from "../lib/solid";

export interface ResponseDestination { turnId: string; messageId: string; preview: string; }

function responseTarget(root: HTMLElement, response: ResponseDestination) {
  return root.querySelector<HTMLElement>(`[data-response-id="${CSS.escape(response.messageId)}"]`)
    ?? root.querySelector<HTMLElement>(`[data-response-turn="${CSS.escape(response.turnId)}"]`);
}

export function ResponseNavigator(props: { responses: ResponseDestination[]; scrollRoot: RefObject<HTMLDivElement | null>; onNavigate: () => void }) {
  const [active, setActive] = createSignal<string>();
  const [bottom, setBottom] = createSignal("14px");
  const [overflowing, setOverflowing] = createSignal(false);
  const frame = createRef<number | undefined>(undefined);
  const navigationFrame = createRef<number | undefined>(undefined);
  const rail = createRef<HTMLElement>(null);

  createDependencyEffect(() => {
    const container = rail.current;
    const marker = container?.querySelector<HTMLElement>("[aria-current]");

    if (!container || !marker) return;
    if (marker.offsetTop < container.scrollTop) container.scrollTop = marker.offsetTop;
    else if (marker.offsetTop + marker.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = marker.offsetTop + marker.offsetHeight - container.clientHeight;
  }, () => [active()]);

  createDependencyEffect(() => {
    const root = props.scrollRoot.current;

    if (!root) return;
    const update = () => {
      frame.current = undefined;
      setOverflowing(root.scrollHeight > root.clientHeight + 2);
      const top = root.getBoundingClientRect().top + 24;
      let current: string | undefined = props.responses[0]?.messageId;

      for (const response of props.responses) {
        const target = responseTarget(root, response);

        if (!target || target.getBoundingClientRect().top > top) break;
        current = response.messageId;
      }

      if (root.scrollHeight - root.scrollTop - root.clientHeight <= 2) current = props.responses.at(-1)?.messageId;
      setActive(current);
      setBottom(`calc(${root.style.getPropertyValue("--composer-height") || "0px"} + 14px)`);
    };
    const schedule = () => { if (frame.current === undefined) frame.current = requestAnimationFrame(update); };
    root.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    const conversation = root.querySelector(".conversation");

    if (conversation) resize.observe(conversation);
    const mutation = new MutationObserver(schedule);
    mutation.observe(root, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    schedule();

    return () => {
      root.removeEventListener("scroll", schedule);
      resize.disconnect();
      mutation.disconnect();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      if (navigationFrame.current !== undefined) cancelAnimationFrame(navigationFrame.current);
      frame.current = undefined;
      navigationFrame.current = undefined;
    };
  }, () => [props.responses, props.scrollRoot]);

  const navigate = (response: ResponseDestination) => {
    const root = props.scrollRoot.current;
    const turn = root?.querySelector<HTMLElement>(`[data-response-turn="${CSS.escape(response.turnId)}"]`);

    if (!root || !turn) return;
    props.onNavigate();
    turn.dispatchEvent(new Event("piop:reveal-turn"));
    if (navigationFrame.current !== undefined) cancelAnimationFrame(navigationFrame.current);
    navigationFrame.current = requestAnimationFrame(() => {
      navigationFrame.current = undefined;
      const target = responseTarget(root, response);

      if (!target) return;
      props.onNavigate();
      root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top - 24;
      setActive(response.messageId);
    });
  };

  return <Show when={props.responses.length >= 2 && overflowing()}><nav ref={element => { rail.current = element; }} class="response-navigator" aria-label="Agent responses" style={{ bottom: bottom() }}>
    <Key each={props.responses} by={response => response.messageId}>{(response, index) => <button type="button" class="response-navigator-marker" aria-label={`Go to agent response ${index() + 1}: ${response().preview}`} aria-current={active() === response().messageId ? "location" : undefined} title={`Response ${index() + 1}: ${response().preview}`} onClick={() => navigate(response())}><span /></button>}</Key>
  </nav></Show>;
}
