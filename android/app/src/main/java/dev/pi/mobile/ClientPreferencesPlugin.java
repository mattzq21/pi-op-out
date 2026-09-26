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
    private SharedPreferences preferences() {
        return getContext().getSharedPreferences("piop-client-settings", Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void load(PluginCall call) {
        try {
            String stored = preferences().getString("settings", null);
            JSObject result = new JSObject();
            result.put("settings", stored == null ? JSONObject.NULL : new JSObject(stored));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not read client preferences", error);
        }
    }

    @PluginMethod
    public void save(PluginCall call) {
        JSObject settings = call.getObject("settings");
        if (settings == null) { call.reject("Missing client preferences"); return; }
        if (!preferences().edit().putString("settings", settings.toString()).commit()) {
            call.reject("Could not save client preferences");
            return;
        }
        call.resolve();
    }
}
