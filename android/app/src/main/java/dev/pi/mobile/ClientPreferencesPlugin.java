package dev.pi.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "ClientPreferences")
public class ClientPreferencesPlugin extends Plugin {
    private static final Object STORAGE_LOCK = new Object();

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences("piop-client-settings", Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void load(PluginCall call) {
        synchronized (STORAGE_LOCK) {
            try {
                String stored = preferences().getString("settings", null);
                JSObject result = new JSObject();
                result.put("settings", stored == null ? JSONObject.NULL : new JSObject(stored));
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Could not read client preferences", error);
            }
        }
    }

    private static Set<String> memberships(JSONObject settings, String field) throws JSONException {
        Set<String> result = new LinkedHashSet<>();
        if (!settings.has(field)) {
            if (field.equals("knownModels")) return result;
            throw new JSONException("Missing client preference " + field);
        }
        JSONArray values = settings.getJSONArray(field);
        for (int index = 0; index < values.length(); index++) {
            Object value = values.get(index);
            if (!(value instanceof String)) throw new JSONException("Invalid client preference " + field);
            result.add((String) value);
        }
        return result;
    }

    private static void validate(JSONObject settings) throws JSONException {
        JSONObject shortcuts = settings.getJSONObject("keybindings");
        Iterator<String> keys = shortcuts.keys();
        while (keys.hasNext()) {
            if (!(shortcuts.get(keys.next()) instanceof String)) throw new JSONException("Invalid client preference keybindings");
        }
        memberships(settings, "hiddenModels");
        memberships(settings, "knownModels");
        if (!(settings.get("debugMode") instanceof Boolean)) throw new JSONException("Invalid client preference debugMode");
    }

    private static void mergeMemberships(JSONObject latest, JSONObject baseline, JSONObject intended, String field) throws JSONException {
        Set<String> before = memberships(baseline, field);
        Set<String> after = memberships(intended, field);
        Set<String> merged = memberships(latest, field);
        for (String value : before) if (!after.contains(value)) merged.remove(value);
        for (String value : after) if (!before.contains(value)) merged.add(value);
        if (latest.has(field) || intended.has(field)) latest.put(field, new JSONArray(merged));
    }

    private static void mergeKeybindings(JSONObject latest, JSONObject baseline, JSONObject intended) throws JSONException {
        JSONObject current = latest.getJSONObject("keybindings");
        JSONObject before = baseline.getJSONObject("keybindings");
        JSONObject after = intended.getJSONObject("keybindings");
        Set<String> keys = new LinkedHashSet<>();
        before.keys().forEachRemaining(keys::add);
        after.keys().forEachRemaining(keys::add);
        for (String key : keys) {
            Object oldValue = before.opt(key);
            Object newValue = after.opt(key);
            if (java.util.Objects.equals(oldValue, newValue)) continue;
            Object currentValue = current.opt(key);
            if (!java.util.Objects.equals(currentValue, oldValue) && !java.util.Objects.equals(currentValue, newValue)) {
                throw new JSONException("Client preference conflict at keybindings." + key + ": another window changed this shortcut. Reload the latest preferences and choose the shortcut again.");
            }
            if (newValue == null) current.remove(key);
            else current.put(key, newValue);
        }
    }

    private static JSONObject merge(JSONObject latest, JSONObject baseline, JSONObject intended) throws JSONException {
        mergeKeybindings(latest, baseline, intended);
        mergeMemberships(latest, baseline, intended, "hiddenModels");
        mergeMemberships(latest, baseline, intended, "knownModels");
        if (!intended.get("debugMode").equals(baseline.get("debugMode"))) latest.put("debugMode", intended.get("debugMode"));
        return latest;
    }

    @PluginMethod
    public void save(PluginCall call) {
        JSObject settings = call.getObject("settings");
        JSObject baseline = call.getObject("baseline");
        if (settings == null || baseline == null) { call.reject("Client preferences and an editing baseline are required"); return; }
        synchronized (STORAGE_LOCK) {
            try {
                validate(settings);
                validate(baseline);
                SharedPreferences storage = preferences();
                String stored = storage.getString("settings", null);
                JSONObject latest = stored == null ? null : new JSONObject(stored);
                if (latest != null) validate(latest);
                JSONObject committed = latest == null ? settings : Boolean.TRUE.equals(call.getBoolean("initialize")) ? latest : merge(latest, baseline, settings);
                String serialized = committed.toString();
                if (!serialized.equals(stored) && !storage.edit().putString("settings", serialized).commit()) {
                    call.reject("Could not save client preferences");
                    return;
                }
                JSObject result = new JSObject();
                result.put("settings", committed);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), error);
            }
        }
    }
}
