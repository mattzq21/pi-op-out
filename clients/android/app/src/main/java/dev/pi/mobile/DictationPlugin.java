package dev.pi.mobile;

import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.ShortBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** On-device dictation: runs the speech engine chosen in the client preferences. */
@CapacitorPlugin(name = "Dictation")
public class DictationPlugin extends Plugin {
    private static final int SAMPLE_RATE = 16000;
    private static final int MAX_SAMPLES = SAMPLE_RATE * 120;
    private static final int MAX_FEED_SAMPLES = SAMPLE_RATE * 5;
    private static final List<String> NEEDLE_LANGUAGES = Arrays.asList("en", "de", "fr", "es", "it", "nl", "pl");

    /** Runs every native engine call, one after another. It is shared by the whole process: Needle keeps one process-wide model, and a recreated activity makes a new plugin while jobs of the old one still run. */
    private static final ExecutorService engine = Executors.newSingleThreadExecutor();
    /** Runs the idle timers of streams. */
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor();
    private static final int IDLE_SECONDS = 15;
    private final Object lock = new Object();
    private final Object settingsLock = new Object();
    private boolean active;

    /** The engine settings that are loaded or loading. A change reloads the engine. */
    private String settingsKey;
    private int generation;
    private JSObject configuration = state(true, null);
    private Stream stream;
    /** Used only on the engine thread. */
    private Loaded loaded;

    /** A loaded engine. */
    private static final class Loaded {
        final String kind;
        final long model;
        final boolean streaming;
        final String language;

        Loaded(String kind, long model, boolean streaming, String language) {
            this.kind = kind;
            this.model = model;
            this.streaming = streaming;
            this.language = language;
        }
    }

    /** One live dictation. Its audio and text fields are used only on the engine thread. */
    private static final class Stream {
        final String id;
        int samples;
        boolean closed;
        /** Closes the stream when no audio arrives for IDLE_SECONDS. Guarded by lock. */
        ScheduledFuture<?> idle;
        /** Audio that the engine did not take yet: the first pendingLength samples. It grows by doubling, so each sample is copied only a few times. */
        float[] pending = new float[0];
        int pendingLength;
        String committed = "";
        String tentative = "";
        /** The first engine error of this stream. */
        String error;

        Stream(String id) {
            this.id = id;
        }

        void append(float[] samples) {
            if (pendingLength + samples.length > pending.length) pending = Arrays.copyOf(pending, Math.max(pendingLength + samples.length, pending.length * 2));
            System.arraycopy(samples, 0, pending, pendingLength, samples.length);
            pendingLength += samples.length;
        }

        /** Removes and returns the pending audio. */
        float[] takePending() {
            float[] result = Arrays.copyOf(pending, pendingLength);
            pending = new float[0];
            pendingLength = 0;
            return result;
        }
    }

    private static final Set<String> TEXT_FIELDS = Set.of("dictationEngine", "dictationModelPath", "dictationArgs");

    private final ClientPreferencesPlugin.Section preferences = new ClientPreferencesPlugin.Section() {
        private final Set<String> fields = Set.of("dictationEngine", "dictationModelPath", "dictationArgs", "dictationEngines");

        @Override
        public Set<String> fields() {
            return fields;
        }

        @Override
        public void validate(JSONObject settings) throws JSONException {
            for (String field : TEXT_FIELDS) {
                if (settings.has(field) && !(settings.get(field) instanceof String)) throw new JSONException("Invalid client preference " + field);
            }
            engines(settings);
        }

        @Override
        public void merge(JSONObject latest, JSONObject baseline, JSONObject intended) throws JSONException {
            for (String field : TEXT_FIELDS) ClientPreferencesPlugin.mergeField(latest, baseline, intended, field);
            mergeEngines(latest, baseline, intended);
        }

        @Override
        public void changed(JSONObject settings) {
            synchronized (settingsLock) {
                if (active) apply(settings);
            }
        }
    };

    @Override
    public void load() {
        ClientPreferencesPlugin.addSection(preferences);
    }

    private static LinkedHashMap<String, JSONObject> engines(JSONObject settings) throws JSONException {
        LinkedHashMap<String, JSONObject> result = new LinkedHashMap<>();
        if (!settings.has("dictationEngines")) return result;
        JSONArray values = settings.getJSONArray("dictationEngines");
        for (int index = 0; index < values.length(); index++) {
            JSONObject engine = values.getJSONObject(index);
            if (!(engine.get("engine") instanceof String) || (engine.has("path") && !(engine.get("path") instanceof String)) || result.containsKey(engine.getString("engine"))) throw new JSONException("Invalid client preference dictationEngines");
            JSONArray models = engine.getJSONArray("models");
            for (int position = 0; position < models.length(); position++) {
                JSONObject model = models.getJSONObject(position);
                if (!(model.get("path") instanceof String) || (model.has("name") && !(model.get("name") instanceof String)) || (model.has("args") && !(model.get("args") instanceof String))) throw new JSONException("Invalid client preference dictationEngines");
            }
            result.put(engine.getString("engine"), engine);
        }
        return result;
    }

    private static void mergeEngines(JSONObject latest, JSONObject baseline, JSONObject intended) throws JSONException {
        if (!latest.has("dictationEngines") && !intended.has("dictationEngines")) return;
        LinkedHashMap<String, JSONObject> before = engines(baseline);
        LinkedHashMap<String, JSONObject> after = engines(intended);
        LinkedHashMap<String, JSONObject> merged = engines(latest);
        Set<String> types = new LinkedHashSet<>(merged.keySet());
        types.addAll(after.keySet());
        for (String type : types) {
            JSONObject updated = after.get(type);
            if (ClientPreferencesPlugin.same(before.get(type), updated)) continue;
            if (updated == null) merged.remove(type);
            else merged.put(type, updated);
        }
        latest.put("dictationEngines", new JSONArray(merged.values()));
    }

    @Override
    protected void handleOnDestroy() {
        ClientPreferencesPlugin.removeSection(preferences);
        synchronized (lock) {
            generation++;
            closeStream(null);
        }
        timers.shutdownNow();
        engine.execute(this::unload);
    }

    private static JSObject state(boolean loading, String error) {
        JSObject result = new JSObject();
        result.put("enabled", false);
        result.put("loading", loading);
        if (error != null) result.put("error", error);
        return result;
    }

    private static String setting(JSONObject settings, String field) {
        String value = settings == null ? "" : settings.optString(field, "").trim();
        return value;
    }

    /** The engine type: Cactus Needle reads .cact model files and transcribe.cpp reads .gguf model files. */
    private static String engineKind(String engine, String model) {
        String extension;
        String label;
        if (engine.equals("needle")) { extension = ".cact"; label = "Needle"; }
        else if (engine.equals("transcribe.cpp")) { extension = ".gguf"; label = "Transcribe.cpp"; }
        else throw new IllegalArgumentException("Unknown dictation engine " + engine);
        if (!model.toLowerCase(Locale.ROOT).endsWith(extension)) throw new IllegalArgumentException("The model file " + model + " is not a " + extension + " file. " + label + " needs a " + extension + " model.");
        return engine;
    }

    /** Reads the engine arguments. The only argument is "--language <code>" (or "--language=<code>"); no language lets the model choose. */
    private static String languageArgument(String args) {
        String[] words = args.trim().isEmpty() ? new String[0] : args.trim().split("\\s+");
        String language = "";
        for (int index = 0; index < words.length; index++) {
            String word = words[index];
            if (word.equals("--language")) {
                if (++index >= words.length) throw new IllegalArgumentException("The argument --language needs a language code, for example --language en");
                language = words[index];
            } else if (word.startsWith("--language=")) {
                language = word.substring("--language=".length());
            } else {
                throw new IllegalArgumentException("Unknown dictation argument " + word + ". The only argument is --language <code>.");
            }
        }
        return language.toLowerCase(Locale.ROOT);
    }

    /** Reads the client preferences and reloads the engine when its settings changed. */
    private void activate() {
        synchronized (settingsLock) {
            if (active) return;
            active = true;
            reload();
        }
    }

    private void reload() {
        JSONObject settings;
        try (ClientPreferencesStorage storage = new ClientPreferencesStorage(getContext())) {
            String stored = storage.read().settings;
            storage.commit();
            settings = stored == null ? null : new JSONObject(stored);
        } catch (Exception error) {
            publish(state(false, "Could not read the dictation settings: " + error.getMessage()), null);
            return;
        }
        apply(settings);
    }

    private void apply(JSONObject settings) {
        String chosen = setting(settings, "dictationEngine");
        String kind = chosen.isEmpty() ? "transcribe.cpp" : chosen;
        String model = setting(settings, "dictationModelPath");
        String args = setting(settings, "dictationArgs");
        String key = kind + "\n" + model + "\n" + args;
        int current;
        synchronized (lock) {
            if (key.equals(settingsKey)) return;
            settingsKey = key;
            current = ++generation;
            closeStream("Dictation stopped because the speech engine changed");
            configuration = state(true, null);
        }
        notifyListeners("dictation", configuration);
        engine.execute(() -> {
            JSObject result;
            try {
                unload();
                result = model.isEmpty() ? state(false, "No dictation model is configured") : loadEngine(engineKind(kind, model), model, languageArgument(args));
            } catch (Throwable error) {
                result = state(false, message(error));
            }
            publish(result, current);
        });
    }

    private void publish(JSObject result, Integer expected) {
        synchronized (lock) {
            if (expected != null && expected != generation) return;
            configuration = result;
        }
        notifyListeners("dictation", result);
    }

    private static String message(Throwable error) {
        String text = error.getMessage();
        return text == null || text.isEmpty() ? error.toString() : text;
    }

    private void unload() {
        if (loaded != null && loaded.kind.equals("transcribe.cpp")) SpeechNative.transcribeFree(loaded.model);
        loaded = null;
    }

    /** Runs on the engine thread. */
    private JSObject loadEngine(String kind, String model, String language) throws Exception {
        unload();
        if (model.isEmpty()) return state(false, "No dictation model is configured");
        if (!new File(model).isFile()) return state(false, "The model file " + model + " does not exist");
        List<String> languages = new ArrayList<>();
        boolean detect;
        if (kind.equals("needle")) {
            SpeechNative.needleLoad(model);
            languages.addAll(NEEDLE_LANGUAGES);
            detect = true;
            loaded = new Loaded(kind, 0, true, language);
        } else if (kind.equals("transcribe.cpp")) {
            long handle = SpeechNative.transcribeLoad(model);
            JSONObject capabilities;
            try {
                capabilities = new JSONObject(SpeechNative.transcribeCapabilities(handle));
            } catch (Throwable error) {
                SpeechNative.transcribeFree(handle);
                throw error;
            }
            JSONArray known = capabilities.getJSONArray("languages");
            for (int index = 0; index < known.length(); index++) languages.add(known.getString(index));
            detect = capabilities.getBoolean("detect");
            loaded = new Loaded(kind, handle, capabilities.getBoolean("streaming"), language);
        } else {
            return state(false, "Unknown speech engine " + kind);
        }
        String name = kind.equals("needle") ? "This Needle model" : "This transcribe.cpp model";
        if (!language.isEmpty() && !languages.isEmpty() && !languages.contains(language)) {
            unload();
            return state(false, name + " cannot use the language '" + language + "'. Use one of: " + String.join(", ", languages));
        }
        if (language.isEmpty() && !detect && languages.size() > 1) {
            unload();
            return state(false, name + " cannot detect the language. Set one of: " + String.join(", ", languages));
        }
        JSObject result = new JSObject();
        result.put("enabled", true);
        result.put("loading", false);
        result.put("engine", kind);
        result.put("language", language);
        result.put("languages", new JSArray(languages));
        result.put("detectLanguage", detect);
        return result;
    }

    @PluginMethod
    public void configuration(PluginCall call) {
        activate();
        synchronized (lock) {
            call.resolve(configuration);
        }
    }

    /** Must hold lock. Stops the current stream and tells its owner why. */
    private void closeStream(String error) {
        Stream current = stream;
        if (current == null) return;
        stream = null;
        if (current.idle != null) current.idle.cancel(false);
        engine.execute(() -> reset(current));
        if (error != null) {
            JSObject event = new JSObject();
            event.put("id", current.id);
            event.put("error", error);
            notifyListeners("dictation-stream", event);
        }
    }

    /** Runs on the engine thread. Throws away the stream's audio and text. */
    private void reset(Stream current) {
        if (current.closed) return;
        current.closed = true;
        if (loaded == null) return;
        try {
            if (loaded.kind.equals("needle")) SpeechNative.needleStop();
            else if (loaded.streaming) SpeechNative.transcribeReset(loaded.model);
        } catch (Throwable ignored) {
            // The engine starts the next stream from a clean state either way.
        }
    }

    private Stream owned(String id) {
        if (stream == null || !stream.id.equals(id)) throw new IllegalStateException("This dictation is no longer running");
        return stream;
    }

    /** Called with lock held. Restarts the wait for the next audio of this stream. */
    private void armIdle(Stream current) {
        if (current.idle != null) current.idle.cancel(false);
        current.idle = timers.schedule(() -> {
            synchronized (lock) {
                if (stream == current) closeStream("Dictation stopped because no audio arrived for " + IDLE_SECONDS + " seconds");
            }
        }, IDLE_SECONDS, TimeUnit.SECONDS);
    }

    @PluginMethod
    public void start(PluginCall call) {
        Stream started;
        synchronized (lock) {
            if (!configuration.optBoolean("enabled")) {
                String error = configuration.optString("error", "");
                call.reject(error.isEmpty() ? "Dictation is unavailable" : "Dictation is unavailable: " + error);
                return;
            }
            closeStream("Dictation stopped because a new dictation started");
            started = new Stream(UUID.randomUUID().toString());
            stream = started;
            armIdle(started);
        }
        engine.execute(() -> {
            if (started.closed || loaded == null) return;
            try {
                if (loaded.kind.equals("transcribe.cpp") && loaded.streaming) SpeechNative.transcribeBegin(loaded.model, loaded.language);
            } catch (Throwable error) {
                fail(started, message(error));
            }
        });
        JSObject result = new JSObject();
        result.put("id", started.id);
        call.resolve(result);
    }

    /** Runs on the engine thread. Ends a stream after an engine error, and keeps the error for finish. */
    private void fail(Stream failed, String error) {
        if (failed.error == null) failed.error = error;
        synchronized (lock) {
            if (stream == failed) closeStream(error);
        }
    }

    private static float[] decode(String audio) {
        byte[] bytes = Base64.decode(audio, Base64.NO_WRAP);
        if (bytes.length % 2 != 0) throw new IllegalArgumentException("Invalid dictation audio");
        ShortBuffer shorts = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer();
        float[] samples = new float[shorts.remaining()];
        for (int index = 0; index < samples.length; index++) samples[index] = shorts.get(index) / 32768f;
        return samples;
    }

    private static String join(String left, String right) {
        return !left.isEmpty() && !right.isEmpty() ? (left + " " + right).trim() : left.isEmpty() ? right : left;
    }

    @PluginMethod
    public void feed(PluginCall call) {
        String id = call.getString("id", "");
        float[] samples;
        try {
            samples = decode(call.getString("audio", ""));
        } catch (IllegalArgumentException error) {
            call.reject("Invalid dictation audio");
            return;
        }
        if (samples.length > MAX_FEED_SAMPLES) { call.reject("Invalid dictation audio"); return; }
        Stream current;
        synchronized (lock) {
            try {
                current = owned(id);
            } catch (IllegalStateException error) {
                call.reject(error.getMessage());
                return;
            }
            if (current.samples + samples.length > MAX_SAMPLES) { call.reject("Dictation recording is too long"); return; }
            current.samples += samples.length;
            armIdle(current);
        }
        engine.execute(() -> {
            if (current.closed || current.error != null || loaded == null) return;
            try {
                process(current, samples);
            } catch (Throwable error) {
                fail(current, message(error));
            }
        });
        call.resolve();
    }

    private void emitText(Stream current) {
        JSObject event = new JSObject();
        event.put("id", current.id);
        event.put("committed", current.committed);
        event.put("tentative", current.tentative);
        notifyListeners("dictation-stream", event);
    }

    /** Runs on the engine thread. Needle takes about one second at a time; transcribe.cpp takes any amount. */
    private void process(Stream current, float[] samples) throws Exception {
        if (loaded.kind.equals("needle")) {
            current.append(samples);
            int start = 0;
            try {
                while (current.pendingLength - start >= SAMPLE_RATE) {
                    float[] chunk = Arrays.copyOfRange(current.pending, start, start + SAMPLE_RATE);
                    start += SAMPLE_RATE;
                    needleStep(current, SpeechNative.needleProcess(chunk, loaded.language));
                }
            } finally {
                System.arraycopy(current.pending, start, current.pending, 0, current.pendingLength - start);
                current.pendingLength -= start;
            }
        } else if (loaded.streaming) {
            String update = SpeechNative.transcribeFeed(loaded.model, samples);
            if (update == null) return;
            JSONObject text = new JSONObject(update);
            current.committed = text.getString("committed").trim();
            current.tentative = text.getString("tentative").trim();
            emitText(current);
        } else {
            current.append(samples);
        }
    }

    private void needleStep(Stream current, String result) throws Exception {
        JSONObject step = new JSONObject(result);
        String committed = step.optString("text", "").trim();
        String pending = step.optString("pending", "").trim();
        if (committed.isEmpty() && pending.equals(current.tentative)) return;
        current.committed = join(current.committed, committed);
        current.tentative = pending;
        emitText(current);
    }

    @PluginMethod
    public void finish(PluginCall call) {
        String id = call.getString("id", "");
        Stream current;
        synchronized (lock) {
            try {
                current = owned(id);
            } catch (IllegalStateException error) {
                call.reject(error.getMessage());
                return;
            }
            stream = null;
            if (current.idle != null) current.idle.cancel(false);
        }
        engine.execute(() -> {
            if (current.error != null) { reset(current); call.reject(current.error); return; }
            if (current.closed || loaded == null) { call.reject("This dictation is no longer running"); return; }
            try {
                String text;
                if (loaded.kind.equals("needle")) {
                    float[] rest = current.takePending();
                    if (rest.length > 0) needleStep(current, SpeechNative.needleProcess(rest, loaded.language));
                    current.closed = true;
                    needleStep(current, SpeechNative.needleStop());
                    text = join(current.committed, current.tentative);
                } else if (loaded.streaming) {
                    current.closed = true;
                    JSONObject result = new JSONObject(SpeechNative.transcribeFinish(loaded.model));
                    text = (result.getString("committed") + result.getString("tentative")).trim();
                } else {
                    current.closed = true;
                    float[] recording = current.takePending();
                    text = recording.length == 0 ? "" : SpeechNative.transcribeRun(loaded.model, recording, loaded.language).trim();
                }
                JSObject result = new JSObject();
                result.put("text", text);
                call.resolve(result);
            } catch (Throwable error) {
                reset(current);
                call.reject(message(error));
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id", "");
        synchronized (lock) {
            if (stream != null && stream.id.equals(id)) closeStream(null);
        }
        call.resolve();
    }
}
