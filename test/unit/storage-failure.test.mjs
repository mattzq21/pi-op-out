import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daemonError, storageFailure } from '../../clients/ui/lib/storageFailure.ts';

const fromDaemon = text => daemonError(new Error(text));

test('a failed archive, delete or restore tells the user whether anything changed', () => {
  assert.deepEqual(storageFailure('archive', fromDaemon('piop-storage-state:rolled-back\nDisk full')), { title: 'Could not archive conversation', message: 'Nothing was changed. Disk full' });
  assert.deepEqual(storageFailure('delete', fromDaemon('piop-storage-state:pending\nCrashed'), 3), { title: 'Deletion did not finish', message: 'Piop will finish or undo it before the next archive, delete or restore. Crashed' });
  assert.deepEqual(storageFailure('restore', fromDaemon('piop-storage-state:unknown\nLost connection')), { title: 'Restore result is unknown', message: 'Piop could not confirm what happened. Refresh to see the current state. Lost connection' });
  assert.deepEqual(storageFailure('delete', fromDaemon('Session is running'), 2), { title: 'Could not delete conversations', message: 'Session is running' });
  assert.deepEqual(storageFailure('archive', fromDaemon('see piop-storage-state:pending\nlater')), { title: 'Could not archive conversation', message: 'see piop-storage-state:pending\nlater' }, 'the state mark only counts at the start');
});
