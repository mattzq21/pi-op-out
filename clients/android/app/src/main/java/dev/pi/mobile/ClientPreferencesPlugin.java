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
import java.util.concurrent.CopyOnWriteArrayList;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "ClientPreferences")
public class ClientPreferencesPlugin extends Plugin {
    private static final Object STORAGE_LOCK = new Object();
    private static final Set<String> CORE_FIELDS = Set.of("keybindings", "debugMode");
    private static final CopyOnWriteArrayList<Section> sections = new CopyOnWriteArrayList<>();

    interface Section {
        Set<String> fields();

        void validate(JSONObject settings) throws JSONException;

        default void merge(JSONObject latest, JSONObject baseline, JSONObject intended) throws JSONException {
            for (String field : fields()) mergeField(latest, baseline, intended, field);
        }

        void changed(JSONObject settings);
    }

    static void addSection(Section section) {
        for (Section other : sections) {
            for (String field : section.fields()) {
                if (CORE_FIELDS.contains(field) || other.fields().contains(field)) throw new IllegalStateException("The client preference field " + field + " has two owners");
            }
        }
        sections.add(section);
    }

    static void removeSection(Section section) {
        sections.remove(section);
    }

    static void mergeField(JSONObject latest, JSONObject baseline, JSONObject intended, String field) throws JSONException {
        Object after = intended.opt(field);
        if (same(baseline.opt(field), after)) return;
        if (after == null) latest.remove(field);
        else latest.put(field, after);
    }

    static boolean same(Object left, Object right) {
        return Objects.equals(left == null ? null : left.toString(), right == null ? null : right.toString());
    }

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
        for (Section section : sections) section.validate(settings);
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
        Set<String> owned = new LinkedHashSet<>(CORE_FIELDS);
        for (Section section : sections) {
            section.merge(latest, baseline, intended);
            owned.addAll(section.fields());
        }
        Set<String> rest = new LinkedHashSet<>();
        baseline.keys().forEachRemaining(rest::add);
        intended.keys().forEachRemaining(rest::add);
        rest.removeAll(owned);
        for (String field : rest) mergeField(latest, baseline, intended, field);
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
                for (Section section : sections) section.changed(new JSONObject(serialized));
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
