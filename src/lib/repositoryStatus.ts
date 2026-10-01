import { createMemo, createSignal, type Accessor } from "solid-js";
import type { NativeTransport } from "./nativeTransport";
import type { ChatMessage, SessionSummary } from "../types";
import { createDependencyEffect } from "./solid";

export function createRepositoryStatus(transport: Accessor<NativeTransport>, projectKind: Accessor<SessionSummary["projectKind"]>, messages: Accessor<ChatMessage[]>, streaming: Accessor<boolean>) {
  const [isGitRepository, setIsGitRepository] = createSignal<boolean>();
  createDependencyEffect(() => { const capturedTransport = transport();
    let cancelled = false;
    setIsGitRepository(undefined);
    void capturedTransport.isGitRepository().then((isRepository) => { if (!cancelled) setIsGitRepository(isRepository); }).catch(() => undefined);

    return () => { cancelled = true; };
  }, () => [transport(), projectKind()]);

  const latestPromptId = createMemo(() => {
    const history = messages();

    for (let index = history.length - 1; index >= 0; index--) {
      if (history[index].role === "user") return history[index].id;
    }
  });

  createDependencyEffect(() => {
    if (isGitRepository() !== false || !latestPromptId()) return;
    const owner = transport();
    let cancelled = false;
    void owner.isGitRepository().then(isRepository => {
      if (!cancelled && transport() === owner) setIsGitRepository(isRepository);
    }).catch(() => undefined);

    return () => { cancelled = true; };
  }, () => [transport(), latestPromptId(), streaming(), isGitRepository()]);


  return isGitRepository;
}
