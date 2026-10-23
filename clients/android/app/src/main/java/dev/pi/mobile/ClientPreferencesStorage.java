package dev.pi.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

final class ClientPreferencesStorage implements AutoCloseable {
    private final SQLiteDatabase database;

    static final class Saved {
        final String settings;
        final String revision;

        Saved(String settings, String revision) {
            this.settings = settings;
            this.revision = revision;
        }
    }

    ClientPreferencesStorage(Context context) {
        database = context.openOrCreateDatabase("piop-client-settings.sqlite", Context.MODE_PRIVATE, null);
        try {
            database.enableWriteAheadLogging();
            database.execSQL("PRAGMA synchronous=FULL");
            database.execSQL("CREATE TABLE IF NOT EXISTS client_preferences (id INTEGER PRIMARY KEY CHECK(id=1), settings TEXT, revision TEXT NOT NULL)");
            database.beginTransaction();
            if (read() == null) write(null, "missing");
        } catch (RuntimeException error) {
            close();
            throw error;
        }
    }

    Saved read() {
        try (Cursor cursor = database.rawQuery("SELECT settings, revision FROM client_preferences WHERE id=1", null)) {
            return cursor.moveToFirst() ? new Saved(cursor.isNull(0) ? null : cursor.getString(0), cursor.getString(1)) : null;
        }
    }

    void write(String settings, String revision) {
        ContentValues values = new ContentValues();
        values.put("id", 1);
        values.put("settings", settings);
        values.put("revision", revision);
        if (database.insertWithOnConflict("client_preferences", null, values, SQLiteDatabase.CONFLICT_REPLACE) == -1) {
            throw new IllegalStateException("Could not save client preferences");
        }
    }

    void commit() {
        database.setTransactionSuccessful();
        database.endTransaction();
    }

    @Override
    public void close() {
        try {
            if (database.inTransaction()) database.endTransaction();
        } finally {
            database.close();
        }
    }
}
