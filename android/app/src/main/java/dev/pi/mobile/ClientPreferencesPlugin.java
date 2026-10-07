package dev.pi.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

@CapacitorPlugin(name = "ClientPreferences")
public class ClientPreferencesPlugin extends Plugin {
    private static final Object STORAGE_LOCK = new Object();

    private String revision(SharedPreferences preferences) {
        String stored = preferences.getString("settings", null);
        return preferences.getString("revision", stored == null ? "missing" : "legacy:" + java.util.UUID.nameUUIDFromBytes(stored.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences("piop-client-settings", Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void load(PluginCall call) {
        synchronized (STORAGE_LOCK) {
        try {
            SharedPreferences preferences = preferences();
            String stored = preferences.getString("settings", null);
            JSObject result = new JSObject();
            result.put("settings", stored == null ? JSONObject.NULL : new JSObject(stored));
            result.put("revision", revision(preferences));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not read client preferences", error);
        }
        }
    }

    @PluginMethod
    public void save(PluginCall call) {
        synchronized (STORAGE_LOCK) {
        JSObject settings = call.getObject("settings");
        if (settings == null) { call.reject("Missing client preferences"); return; }
        SharedPreferences preferences = preferences();
        String expected = call.getString("expectedRevision");
        if (expected == null || !expected.equals(revision(preferences))) {
            call.reject("Client preferences changed in another window. Reload the latest settings before saving.");
            return;
        }
        String revision = java.util.UUID.randomUUID().toString();
        if (!preferences.edit().putString("settings", settings.toString()).putString("revision", revision).commit()) {
            call.reject("Could not save client preferences");
            return;
        }
        JSObject result = new JSObject();
        result.put("revision", revision);
        call.resolve(result);
        }
    }
}
