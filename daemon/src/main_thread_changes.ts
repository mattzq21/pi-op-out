// The modules whose database changes worker threads ask the main thread to run. The main thread loads them here, so
// it knows each change by name before a worker asks for it.
import '../resources/agent-definitions-writes.mjs';
import '../resources/application-records.cjs';
import '../resources/chat-branch-history.cjs';
import '../resources/conversation-storage.cjs';
import '../resources/external-transcripts.cjs';
import '../resources/piop-storage/auxiliary-copies.cjs';
import '../resources/piop-storage/goal-files.cjs';
import '../resources/piop-storage/goals.cjs';
import '../resources/piop-storage/session-records.cjs';
import '../resources/session-broker/session-child-index.cjs';
import '../resources/session-broker/session-names.cjs';
import '../resources/session-database.cjs';
import '../resources/session-lifecycle.cjs';
import '../resources/session-registry.cjs';
import '../resources/storage-locks.cjs';
import '../resources/storage-transcript-cache.cjs';
import '../resources/temporary-chat.cjs';
import '../resources/transcript-metadata.cjs';
import '../resources/transcript-references.cjs';
