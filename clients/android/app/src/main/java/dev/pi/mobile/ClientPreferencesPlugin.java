package dev.pi.mobile;

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
    private static final String[] DICTATION_FIELDS = {"dictationEngine", "dictationModelPath", "dictationArgs"};

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
        for (String field : DICTATION_FIELDS) {
            if (settings.has(field) && !(settings.get(field) instanceof String)) throw new JSONException("Invalid client preference " + field);
        }
        engines(settings);
    }

    /** The dictation engines by engine type. Each has an optional program path and a list of models with optional arguments. */
    private static java.util.LinkedHashMap<String, JSONObject> engines(JSONObject settings) throws JSONException {
        java.util.LinkedHashMap<String, JSONObject> result = new java.util.LinkedHashMap<>();
        if (!settings.has("dictationEngines")) return result;
        JSONArray values = settings.getJSONArray("dictationEngines");
        for (int index = 0; index < values.length(); index++) {
            JSONObject engine = values.getJSONObject(index);
            if (!(engine.get("engine") instanceof String) || (engine.has("path") && !(engine.get("path") instanceof String)) || result.containsKey(engine.getString("engine"))) throw new JSONException("Invalid client preference dictationEngines");
            JSONArray models = engine.getJSONArray("models");
            for (int position = 0; position < models.length(); position++) {
                JSONObject model = models.getJSONObject(position);
                if (!(model.get("path") instanceof String) || (model.has("args") && !(model.get("args") instanceof String))) throw new JSONException("Invalid client preference dictationEngines");
            }
            result.put(engine.getString("engine"), engine);
        }
        return result;
    }

    /** Merges the engines by engine type. An engine that this window changed takes this window's value. */
    private static void mergeEngines(JSONObject latest, JSONObject baseline, JSONObject intended) throws JSONException {
        if (!latest.has("dictationEngines") && !intended.has("dictationEngines")) return;
        java.util.LinkedHashMap<String, JSONObject> before = engines(baseline);
        java.util.LinkedHashMap<String, JSONObject> after = engines(intended);
        java.util.LinkedHashMap<String, JSONObject> merged = engines(latest);
        Set<String> types = new LinkedHashSet<>(merged.keySet());
        types.addAll(after.keySet());
        for (String type : types) {
            JSONObject old = before.get(type);
            JSONObject updated = after.get(type);
            if (java.util.Objects.equals(old == null ? null : old.toString(), updated == null ? null : updated.toString())) continue;
            if (updated == null) merged.remove(type);
            else merged.put(type, updated);
        }
        latest.put("dictationEngines", new JSONArray(merged.values()));
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
        mergeEngines(latest, baseline, intended);
        if (!intended.get("debugMode").equals(baseline.get("debugMode"))) latest.put("debugMode", intended.get("debugMode"));
        for (String field : DICTATION_FIELDS) {
            Object before = baseline.opt(field);
            Object after = intended.opt(field);
            if (java.util.Objects.equals(before, after)) continue;
            if (after == null) latest.remove(field);
            else latest.put(field, after);
        }
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
                com.getcapacitor.PluginHandle dictation = getBridge().getPlugin("Dictation");
                if (dictation != null) ((DictationPlugin) dictation.getInstance()).reload();
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
