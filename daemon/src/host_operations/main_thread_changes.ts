// The modules whose database changes worker threads ask the main thread to run. The main thread loads them here, so
// it knows each change by name before a worker asks for it.
import '../../resources/agent-definitions-writes.ts';
import '../../resources/application-records.ts';
import '../../resources/chat-branch-history.ts';
import '../../resources/conversation-storage.ts';
import '../../resources/external-transcripts.ts';
import '../../resources/piop-storage/auxiliary-copies.ts';
import '../../resources/piop-storage/goal-assets.ts';
import '../../resources/piop-storage/goal-dependencies.ts';
import '../../resources/piop-storage/goal-ownership.ts';
import '../../resources/piop-storage/goal-preparations.ts';
import '../../resources/piop-storage/goals.ts';
import '../../resources/piop-storage/retention-candidates.ts';
import '../../resources/piop-storage/session-records.ts';
import '../../resources/registry-deletion.ts';
import '../../resources/restore-receipts.ts';
import '../../resources/session-broker/session-child-index.ts';
import '../../resources/session-broker/session-names.ts';
import '../../resources/session-database/core.ts';
import '../../resources/session-registry.ts';
import '../../resources/storage-locks.ts';
import '../../resources/storage-transaction.ts';
import '../../resources/storage-transcript-cache.ts';
import '../../resources/temporary-chat.ts';
import '../../resources/transcript-metadata.ts';
import '../../resources/transcript-references.ts';
