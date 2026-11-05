// The modules whose database changes worker threads ask the main thread to run. The main thread loads them here, so
// it knows each change by name before a worker asks for it.
import '../../resources/agent-definitions-writes.ts';
import '../../resources/application-records.ts';
import '../../resources/chat-branch-history.ts';
import '../../resources/conversation-storage.ts';
import '../../resources/piop-storage/goal-files.ts';
import '../../resources/piop-storage/goals.ts';
import '../../resources/piop-storage/new-chats.ts';
import '../../resources/piop-storage/session-records.ts';
import '../../resources/session-broker/session-names.ts';
import '../../resources/session-database.ts';
import '../../resources/session-lifecycle.ts';
import '../../resources/session-registry.ts';
import '../../resources/storage-locks.ts';
import '../../resources/temporary-chat.ts';
