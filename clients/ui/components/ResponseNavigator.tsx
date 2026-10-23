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
  const [overflowing, setOverflowing] = createSignal(false);
  const frame = createRef<number | undefined>(undefined);
  const navigationFrame = createRef<number | undefined>(undefined);
  const rail = createRef<HTMLElement>(null);
  const targets: { messageId: string; turnId: string; element: HTMLElement }[] = [];
  const visible = () => props.responses.length >= 2 && overflowing();

  createDependencyEffect(() => {
    if (!visible()) return;

    const markerFrame = requestAnimationFrame(() => {
      const container = rail.current;
      const marker = container?.querySelector<HTMLElement>("[aria-current]");

      if (!container || !marker) return;

      if (marker.offsetTop < container.scrollTop) container.scrollTop = marker.offsetTop;
      else if (marker.offsetTop + marker.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = marker.offsetTop + marker.offsetHeight - container.clientHeight;
    });

    return () => cancelAnimationFrame(markerFrame);
  }, () => [active(), visible()]);

  createDependencyEffect(() => {
    const root = props.scrollRoot.current;

    if (!root) return;

    const update = () => {
      frame.current = undefined;
      setOverflowing(root.scrollHeight > root.clientHeight + 2);
      targets.length = props.responses.length;
      let current: string | undefined = props.responses[0]?.messageId;

      if (root.scrollHeight - root.scrollTop - root.clientHeight <= 2) current = props.responses.at(-1)?.messageId;
      else {
        const top = root.getBoundingClientRect().top + 24;
        let low = 0, high = props.responses.length;

        while (low < high) {
          const index = (low + high) >>> 1;
          const response = props.responses[index];
          const cached = targets[index];
          let target = cached?.messageId === response.messageId && cached.turnId === response.turnId && root.contains(cached.element) ? cached.element : responseTarget(root, response);

          if (target?.hasAttribute("data-response-turn")) target = target.querySelector<HTMLElement>(`[data-response-id="${CSS.escape(response.messageId)}"]`) ?? target;

          if (target) targets[index] = { messageId: response.messageId, turnId: response.turnId, element: target };

          if (!target || target.getBoundingClientRect().top > top) high = index;
          else { current = response.messageId; low = index + 1; }
        }
      }

      setActive(current);
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

  return <Show when={visible()}><nav ref={element => { rail.current = element; }} class="response-navigator" aria-label="Agent responses">
    <Key each={props.responses} by={response => response.messageId}>{(response, index) => <button type="button" class="response-navigator-marker" aria-label={`Go to agent response ${index() + 1}: ${response().preview}`} aria-current={active() === response().messageId ? "location" : undefined} title={`Response ${index() + 1}: ${response().preview}`} onClick={() => navigate(response())}><span /></button>}</Key>
  </nav></Show>;
}
