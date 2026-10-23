package dev.pi.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Objects;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "ClientPreferences")
public class ClientPreferencesPlugin extends Plugin {
    private static final Object STORAGE_LOCK = new Object();
    @PluginMethod
    public void load(PluginCall call) {
        synchronized (STORAGE_LOCK) {
            try (ClientPreferencesStorage storage = new ClientPreferencesStorage(getContext())) {
                ClientPreferencesStorage.Saved stored = storage.read();
                JSObject result = new JSObject();
                result.put("settings", stored.settings == null ? JSONObject.NULL : new JSObject(stored.settings));
                result.put("revision", stored.revision);
                storage.commit();
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Could not read client preferences", error);
            }
        }
    }

    private static void validate(JSONObject settings) throws JSONException {
        JSONObject shortcuts = settings.getJSONObject("keybindings");
        Iterator<String> keys = shortcuts.keys();
        while (keys.hasNext()) {
            if (!(shortcuts.get(keys.next()) instanceof String)) throw new JSONException("Invalid client preference keybindings");
        }
        if (!(settings.get("debugMode") instanceof Boolean)) throw new JSONException("Invalid client preference debugMode");
        Object off = settings.opt("debugFeaturesOff");
        if (off != null && !(off instanceof JSONArray)) throw new JSONException("Invalid client preference debugFeaturesOff");
        if (off != null) for (int index = 0; index < ((JSONArray) off).length(); index++) if (!(((JSONArray) off).get(index) instanceof String)) throw new JSONException("Invalid client preference debugFeaturesOff");
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
            if (Objects.equals(oldValue, newValue)) continue;
            Object currentValue = current.opt(key);
            if (!Objects.equals(currentValue, oldValue) && !Objects.equals(currentValue, newValue)) {
                throw new JSONException("Client preference conflict at keybindings." + key + ": another window changed this shortcut. Reload the latest preferences and choose the shortcut again.");
            }
            if (newValue == null) current.remove(key);
            else current.put(key, newValue);
        }
    }

    private static JSONObject merge(JSONObject latest, JSONObject baseline, JSONObject intended) throws JSONException {
        mergeKeybindings(latest, baseline, intended);
        if (!intended.get("debugMode").equals(baseline.get("debugMode"))) latest.put("debugMode", intended.get("debugMode"));
        String intendedOff = String.valueOf(intended.opt("debugFeaturesOff"));
        if (!intendedOff.equals(String.valueOf(baseline.opt("debugFeaturesOff")))) latest.put("debugFeaturesOff", intended.opt("debugFeaturesOff"));
        return latest;
    }

    @PluginMethod
    public void save(PluginCall call) {
        JSObject settings = call.getObject("settings");
        JSObject baseline = call.getObject("baseline");
        if (settings == null || baseline == null) { call.reject("Client preferences and an editing baseline are required"); return; }
        synchronized (STORAGE_LOCK) {
            try (ClientPreferencesStorage storage = new ClientPreferencesStorage(getContext())) {
                validate(settings);
                validate(baseline);
                String stored = storage.read().settings;
                JSONObject latest = stored == null ? null : new JSONObject(stored);
                if (latest != null) validate(latest);
                JSONObject committed = latest == null ? settings : Boolean.TRUE.equals(call.getBoolean("initialize")) ? latest : merge(latest, baseline, settings);
                String serialized = committed.toString();
                String revision = java.util.UUID.randomUUID().toString();
                storage.write(serialized, revision);
                storage.commit();
                JSObject publication = new JSObject();
                publication.put("committed", true);
                publication.put("durable", true);
                JSObject result = new JSObject();
                result.put("settings", committed);
                result.put("revision", revision);
                result.put("publication", publication);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), error);
            }
        }
    }
}
