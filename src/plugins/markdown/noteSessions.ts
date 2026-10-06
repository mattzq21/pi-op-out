import { createEffect, createRoot, createSignal, onCleanup, type Accessor } from "solid-js";
import { useChatNote, type ChatNoteTarget } from "./useNotes";

interface NoteSession {
  note: ReturnType<typeof useChatNote>;
  show: (consumer: symbol, visible: boolean) => void;
  detach: (consumer: symbol) => void;
}

const sessions = new Map<string, NoteSession>();

function createSession(key: string, target: ChatNoteTarget, shown: boolean): NoteSession {
  return createRoot(dispose => {
    const consumers = new Map<symbol, boolean>();
    const [visible, setVisible] = createSignal(shown);
    const [attached, setAttached] = createSignal(0);
    const note = useChatNote(target, visible);
    const update = () => { setVisible([...consumers.values()].some(Boolean)); setAttached(consumers.size); };

    const session = {
      note,
      show: (consumer: symbol, shown: boolean) => { consumers.set(consumer, shown); update(); },
      detach: (consumer: symbol) => { consumers.delete(consumer); update(); },
    };

    createEffect(() => {
      if (attached() || note.pending()) return;
      sessions.delete(key); dispose();
    });

    return session;
  }, null);
}

export function useNoteSession(target: ChatNoteTarget, visible: Accessor<boolean>) {
  const key = JSON.stringify([target.hostId, target.sessionId]);
  const session = sessions.get(key) ?? createSession(key, target, visible());
  sessions.set(key, session);
  const consumer = Symbol();
  session.show(consumer, visible());
  createEffect(() => session.show(consumer, visible()));
  onCleanup(() => session.detach(consumer));

  return session.note;
}
